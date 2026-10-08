// Experiments on actual bundled compiler output. These helpers are never shipped.
const { createRequire } = require("node:module");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { gzipSync } = require("node:zlib");
const [root, directory, scenario, candidate] = process.argv.slice(2);
const babel = createRequire(join(root, "packages/babel/package.json"))(
  "@babel/core"
);

const { build } = createRequire(join(root, "packages/esbuild/package.json"))(
  "esbuild"
);

const t = babel.types;
(async () => {
  const report = { scenario, candidate, formats: {} };

  for (const format of ["esm", "cjs"]) {
    const functions = [];
    const schemas = new Map();
    let sites = 0;
    const code = babel.transformSync(
      readFileSync(join(directory, `${scenario}.${format}.js`), "utf8"),
      {
        babelrc: false,
        configFile: false,
        plugins: [
          () => ({
            visitor: {
              CallExpression(path) {
                if (
                  !t.isIdentifier(path.node.callee) ||
                  !t.isStringLiteral(path.node.arguments[0], { value: "div" })
                )
                  return;

                const props = path.get("arguments.1");
                if (!props.isObjectExpression()) return;

                const properties = props.get("properties");
                const style = properties.find(
                  (p) =>
                    p.isObjectProperty() &&
                    t.isIdentifier(p.node.key, { name: "style" })
                );

                const className = properties.find(
                  (p) =>
                    p.isObjectProperty() &&
                    t.isIdentifier(p.node.key, { name: "className" })
                );
                if (!style || !className) return;

                if (candidate.startsWith("finish")) {
                  if (
                    properties.at(-1) !== style ||
                    properties.at(-2) !== className
                  )
                    throw new Error("Assembly ordering changed");

                  const owned = properties
                    .filter((p) => p !== style && p !== className)
                    .map((p) => t.cloneNode(p.node));

                  if (candidate === "finish-owned") {
                    for (const property of owned) {
                      if (
                        !t.isSpreadElement(property) ||
                        !t.isIdentifier(property.argument)
                      )
                        throw new Error("Unproved props ownership");

                      const binding = path.scope.getBinding(
                        property.argument.name
                      );

                      const declaration = binding?.path;
                      if (
                        binding.referencePaths.length !== 1 ||
                        !declaration?.isVariableDeclarator() ||
                        !t.isObjectPattern(declaration.node.id) ||
                        !t.isIdentifier(declaration.node.init)
                      )
                        throw new Error("Unproved rest ownership");

                      declaration.node.id.properties =
                        declaration.node.id.properties.filter(
                          (p) => !t.isRestElement(p)
                        );
                      property.argument = t.cloneNode(declaration.node.init);
                    }
                  }

                  props.replaceWith(
                    t.callExpression(t.identifier("finishCssProps"), [
                      t.objectExpression(owned),
                      t.cloneNode(className.node.value),
                      t.cloneNode(style.node.value)
                    ])
                  );
                  sites++;

                  return;
                }

                const value = style.get("value");
                if (!value.isObjectExpression()) return;

                const values = value.get("properties");
                if (
                  !values.every(
                    (p) => p.isObjectProperty() && t.isExpression(p.node.value)
                  )
                )
                  return;

                const keys = values.map((p) => {
                  const key = p.node.key;
                  if (t.isStringLiteral(key)) return key.value;

                  if (t.isIdentifier(key) && p.node.computed) {
                    const binding = p.scope.getBinding(key.name)?.path;
                    if (
                      binding?.isVariableDeclarator() &&
                      t.isStringLiteral(binding.node.init)
                    )
                      return binding.node.init.value;
                  }

                  return null;
                });
                if (
                  keys.some(
                    (key) => typeof key !== "string" || !key.startsWith("--")
                  )
                )
                  return;

                if (candidate === "keys") {
                  sites++;
                  values.forEach((property, index) => {
                    property.node.key = t.stringLiteral(keys[index]);
                    property.node.computed = false;
                  });

                  return;
                }

                const schema = JSON.stringify(keys);
                let writer = schemas.get(schema);

                if (!writer) {
                  const id = t.identifier(`writeVars${schemas.size}`);
                  const args = keys.map((_, i) => t.identifier(`v${i}`));
                  functions.push(
                    t.functionDeclaration(
                      id,
                      args,
                      t.blockStatement([
                        t.returnStatement(
                          t.objectExpression(
                            keys.map((key, i) =>
                              t.objectProperty(t.stringLiteral(key), args[i])
                            )
                          )
                        )
                      ])
                    )
                  );
                  writer = { name: id.name, sites: 0 };
                  schemas.set(schema, writer);
                }

                writer.sites++;
                sites++;
                value.replaceWith(
                  t.callExpression(
                    t.identifier(writer.name),
                    values.map((p) => t.cloneNode(p.node.value))
                  )
                );
              },

              Program: {
                exit(path) {
                  if (candidate.startsWith("finish")) {
                    path.pushContainer(
                      "body",
                      babel.template.statement.ast(
                        candidate === "finish-owned"
                          ? 'function finishCssProps(ownedProps, className, style) { delete ownedProps.css; delete ownedProps.className; delete ownedProps.style; Object.defineProperty(ownedProps,"className",{value:className,enumerable:true,writable:true,configurable:true}); Object.defineProperty(ownedProps,"style",{value:style,enumerable:true,writable:true,configurable:true}); return ownedProps; }'
                          : "function finishCssProps(ownedProps, className, style) { return {...ownedProps, className, style}; }"
                      )
                    );
                  } else path.pushContainer("body", functions);
                }
              }
            }
          })
        ]
      }
    ).code;

    const result = await build({
      stdin: { contents: code, resolveDir: root },
      bundle: true,
      write: false,
      format,
      minify: true,
      logLevel: "silent"
    });

    const output = result.outputFiles[0].text;
    const name = `${scenario}-${candidate}`;
    writeFileSync(
      join(directory, `${name}.${format === "esm" ? "mjs" : "cjs"}`),
      output
    );
    report.formats[format] = {
      js: { raw: Buffer.byteLength(output), gzip: gzipSync(output).length },
      sites,
      schemas: schemas.size,
      reusableSchemas: [...schemas.values()].filter((v) => v.sites > 1).length,
      extraObjectsPerCall: candidate === "finish" ? 1 : 0,
      restCopiesRemoved: candidate === "finish-owned" ? 2 : 0,
      descriptorObjects: candidate === "finish-owned" ? 2 : 0
    };
  }

  writeFileSync(
    join(directory, `${scenario}-${candidate}.json`),
    JSON.stringify(report, null, 2)
  );
  process.stdout.write(JSON.stringify(report) + "\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
