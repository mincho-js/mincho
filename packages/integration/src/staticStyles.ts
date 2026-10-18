/** Closed literal authoring programs. Unknown syntax always uses the normal compiler. */
import { parseSync, types as t } from "@babel/core";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { recordCompilationDiagnostic } from "./diagnostics.js";

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Rollup rewrites import.meta.url for CommonJS.
const ownRequire = createRequire(import.meta.url);
const prefix = "/* mincho-static-styles-v1:";
const known: Readonly<Record<string, readonly string[]>> = {
  "@mincho-js/css": ["css", "globalCss"],
  "@vanilla-extract/css": ["style", "globalStyle", "keyframes"]
};

const versions: Readonly<Record<string, string>> = {
  "@mincho-js/css": "0.2.2",
  "@vanilla-extract/css": "1.20.1"
};

// This only rules candidates out. Escapes or comments can obscure import tokens,
// so those sources still receive the complete binding and literal proof below.
const namedIntrinsicImport =
  /\bimport\s*\{[^{}]*\b(?:css|globalCss|style|globalStyle|keyframes)\b/;

type Literal =
  | null
  | boolean
  | number
  | string
  | Literal[]
  | { [key: string]: Literal };

interface Operation {
  local?: string;
  value?: Literal;
  reference?: string;
  call?: { module: string; name: string; args: Literal[] };
}

export interface StaticStyleProgram {
  version: 1;
  scope: { filePath: string; packageName: string };
  modules: string[];
  operations: Operation[];
  exports: Array<{ name: string; local: string }>;
}

const unknown = Symbol("unknown");

function literal(
  node: t.Node | null | undefined,
  depth = 0
): Literal | typeof unknown {
  if (!node || depth > 64) return unknown;
  if (
    t.isTSAsExpression(node) ||
    t.isTSSatisfiesExpression(node) ||
    t.isTSNonNullExpression(node)
  )
    return literal(node.expression, depth + 1);
  if (
    t.isStringLiteral(node) ||
    t.isBooleanLiteral(node) ||
    t.isNumericLiteral(node)
  )
    return typeof node.value === "number" && !Number.isFinite(node.value)
      ? unknown
      : node.value;
  if (t.isNullLiteral(node)) return null;
  if (
    t.isUnaryExpression(node) &&
    (node.operator === "-" || node.operator === "+") &&
    t.isNumericLiteral(node.argument)
  )
    return !Number.isFinite(node.argument.value) ||
      (node.operator === "-" && node.argument.value === 0)
      ? unknown
      : node.operator === "-"
        ? -node.argument.value
        : node.argument.value;

  if (t.isArrayExpression(node)) {
    const values = node.elements.map((value) => literal(value, depth + 1));

    return values.includes(unknown) ? unknown : (values as Literal[]);
  }

  if (t.isObjectExpression(node)) {
    const value: Record<string, Literal> = {};

    for (const property of node.properties) {
      if (
        !t.isObjectProperty(property) ||
        property.computed ||
        property.shorthand
      )
        return unknown;

      const key = t.isIdentifier(property.key)
        ? property.key.name
        : t.isStringLiteral(property.key) || t.isNumericLiteral(property.key)
          ? String(property.key.value)
          : undefined;
      if (
        key === undefined ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        Object.hasOwn(value, key)
      )
        return unknown;

      const child = literal(property.value, depth + 1);
      if (child === unknown) return unknown;

      value[key] = child;
    }

    return value;
  }

  return unknown;
}

function packageVersion(
  require: NodeRequire,
  name: string
): string | undefined {
  let directory = dirname(require.resolve(name));

  while (true) {
    try {
      const value = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8")
      );
      if (value.name === name) return value.version;
    } catch {
      /* A package can have nested directories without a manifest. */
    }

    const parent = dirname(directory);
    if (parent === directory) return;

    directory = parent;
  }
}

/** Identity, API and installed version are checked before any adapter mutation. */
export function staticStyleModules(
  program: StaticStyleProgram,
  filePath: string
): string[] | undefined {
  const modules = program.modules;
  if (!modules.length || modules.some((name) => !known[name])) return;

  try {
    const require = createRequire(resolve(filePath));

    for (const name of [
      ...modules,
      "@vanilla-extract/css/adapter",
      "@vanilla-extract/css/fileScope"
    ])
      if (require.resolve(name) !== ownRequire.resolve(name)) return;

    for (const name of modules)
      if (packageVersion(require, name) !== versions[name]) return;

    return [...modules, "@vanilla-extract/css/fileScope"];
  } catch {
    return;
  }
}

function javascript(program: StaticStyleProgram): string {
  const modules = program.modules;
  const code = modules.map(
    (name, index) =>
      `var __mincho_static_${index}=require(${JSON.stringify(name)});`
  );

  code.push(
    'var __mincho_static_scope=require("@vanilla-extract/css/fileScope");'
  );
  code.push(
    `__mincho_static_scope.setFileScope(${JSON.stringify(program.scope.filePath)},${JSON.stringify(program.scope.packageName)});`
  );
  code.push("try {");

  for (const operation of program.operations) {
    const value = operation.call
      ? `__mincho_static_${modules.indexOf(operation.call.module)}.${operation.call.name}(${operation.call.args.map((arg) => JSON.stringify(arg)).join(",")})`
      : (operation.reference ?? JSON.stringify(operation.value));

    code.push(`${operation.local ? `var ${operation.local}=` : ""}${value};`);
  }

  code.push(
    `module.exports={${program.exports.map(({ name, local }) => `[${JSON.stringify(name)}]:${local}`).join(",")}};`
  );
  code.push("} finally { __mincho_static_scope.endFileScope(); }");

  return code.join("\n");
}

function serialize(program: StaticStyleProgram): string {
  return `${prefix}${Buffer.from(JSON.stringify(program)).toString("base64")} */\n${javascript(program)}`;
}

/** Intrinsic imports, literals and already proven local aliases only. */
export function createStaticStyleSource(input: {
  contents: string;
  originalPath: string;
  rootPath: string;
  packageName: string;
  filePath: string;
}): string | undefined {
  if (Buffer.byteLength(input.contents) > 1024 * 1024) return;

  if (
    !/\\|\/[/*]/.test(input.contents) &&
    !namedIntrinsicImport.test(input.contents)
  ) {
    recordCompilationDiagnostic("static-styles-preflight-skip", {
      reason: "no-intrinsic-import"
    });

    return;
  }

  try {
    const ast = parseSync(input.contents, {
      filename: input.originalPath,
      babelrc: false,
      configFile: false,
      sourceType: "module",
      parserOpts: { plugins: ["typescript", "jsx"] }
    });
    if (!ast) return;

    const imports = new Map<string, { module: string; name: string }>();
    const locals = new Set<string>();
    const program: StaticStyleProgram = {
      version: 1,
      scope: {
        filePath: relative(input.rootPath, input.originalPath).replace(
          /\\/g,
          "/"
        ),
        packageName: input.packageName
      },
      modules: [],
      operations: [],
      exports: []
    };

    for (const statement of ast.program.body) {
      if (t.isImportDeclaration(statement)) {
        if (statement.importKind === "type") continue;
        if (!known[statement.source.value] || !statement.specifiers.length)
          return;
        if (!program.modules.includes(statement.source.value))
          program.modules.push(statement.source.value);

        for (const specifier of statement.specifiers) {
          if (t.isImportSpecifier(specifier) && specifier.importKind === "type")
            continue;
          if (
            !t.isImportSpecifier(specifier) ||
            !t.isIdentifier(specifier.imported) ||
            !known[statement.source.value]!.includes(specifier.imported.name)
          )
            return;

          imports.set(specifier.local.name, {
            module: statement.source.value,
            name: specifier.imported.name
          });
        }

        continue;
      }

      const exported = t.isExportNamedDeclaration(statement);
      if (exported && statement.exportKind === "type") continue;
      if (
        t.isTSTypeAliasDeclaration(statement) ||
        t.isTSInterfaceDeclaration(statement) ||
        t.isEmptyStatement(statement)
      )
        continue;

      if (exported && !statement.declaration) {
        if (statement.source) return;

        for (const specifier of statement.specifiers) {
          if (
            !t.isExportSpecifier(specifier) ||
            !t.isIdentifier(specifier.local) ||
            !t.isIdentifier(specifier.exported)
          )
            return;

          program.exports.push({
            name: specifier.exported.name,
            local: specifier.local.name
          });
        }

        continue;
      }

      const node = exported ? statement.declaration : statement;

      const append = (
        expression: t.Node | null | undefined,
        local?: string
      ): boolean => {
        if (
          t.isCallExpression(expression) &&
          t.isIdentifier(expression.callee)
        ) {
          const intrinsic = imports.get(expression.callee.name);
          if (
            !intrinsic ||
            expression.arguments.length === 0 ||
            expression.arguments.length > 2
          )
            return false;

          const args = expression.arguments.map((argument) =>
            literal(argument)
          );
          if (args.includes(unknown)) return false;

          program.operations.push({
            ...(local ? { local } : {}),
            call: { ...intrinsic, args: args as Literal[] }
          });

          return true;
        }

        if (!local) return false;

        if (t.isIdentifier(expression) && locals.has(expression.name)) {
          program.operations.push({ local, reference: expression.name });

          return true;
        }

        const value = literal(expression);
        if (value === unknown) return false;

        program.operations.push({ local, value });

        return true;
      };

      if (
        t.isVariableDeclaration(node) &&
        ["const", "let", "var"].includes(node.kind)
      ) {
        for (const declaration of node.declarations) {
          if (
            !t.isIdentifier(declaration.id) ||
            locals.has(declaration.id.name) ||
            declaration.id.name.startsWith("__mincho_static_") ||
            ["module", "exports", "require"].includes(declaration.id.name) ||
            !append(declaration.init, declaration.id.name)
          )
            return;

          locals.add(declaration.id.name);

          if (exported)
            program.exports.push({
              name: declaration.id.name,
              local: declaration.id.name
            });
        }
      } else if (t.isExpressionStatement(node)) {
        if (!append(node.expression)) return;
      } else return;
    }

    if (program.exports.some(({ local }) => !locals.has(local))) return;

    program.exports.sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    );

    if (!program.operations.some((operation) => operation.call)) return;
    if (!staticStyleModules(program, input.filePath)) return;

    return serialize(program);
  } catch {
    return;
  }
}

function literalValue(value: unknown, depth = 0): boolean {
  if (depth > 64) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number")
    return Number.isFinite(value) && !Object.is(value, -0);
  if (Array.isArray(value))
    return value.every((entry) => literalValue(entry, depth + 1));

  return (
    typeof value === "object" &&
    Object.entries(value).every(
      ([key, entry]) =>
        !["__proto__", "constructor", "prototype"].includes(key) &&
        literalValue(entry, depth + 1)
    )
  );
}

function validLocal(name: unknown): name is string {
  return (
    typeof name === "string" &&
    t.isValidIdentifier(name) &&
    !name.startsWith("__mincho_static_") &&
    !["module", "exports", "require"].includes(name)
  );
}

/** The proof is carried through ordinary compilation caches as valid fallback JS. */
export function readStaticStyleProgram(
  source: string
): StaticStyleProgram | undefined {
  if (!source.startsWith(prefix) || source.length > 4 * 1024 * 1024) return;

  const end = source.indexOf(" */\n", prefix.length);
  if (end < 0) return;

  try {
    const program = JSON.parse(
      Buffer.from(source.slice(prefix.length, end), "base64").toString("utf8")
    ) as StaticStyleProgram;
    if (
      program.version !== 1 ||
      !Array.isArray(program.modules) ||
      !Array.isArray(program.operations) ||
      !Array.isArray(program.exports)
    )
      return;
    if (
      typeof program.scope?.filePath !== "string" ||
      typeof program.scope?.packageName !== "string" ||
      !program.modules.length ||
      program.modules.some(
        (name) => typeof name !== "string" || !known[name]
      ) ||
      program.modules.length !== new Set(program.modules).size ||
      program.operations.length > 10000
    )
      return;

    const locals = new Set<string>();

    for (const operation of program.operations) {
      if (
        !operation ||
        typeof operation !== "object" ||
        (operation.local !== undefined &&
          (!validLocal(operation.local) || locals.has(operation.local)))
      )
        return;

      if (operation.call) {
        if (
          !program.modules.includes(operation.call.module) ||
          !known[operation.call.module]?.includes(operation.call.name) ||
          !Array.isArray(operation.call.args) ||
          operation.call.args.length < 1 ||
          operation.call.args.length > 2 ||
          !operation.call.args.every((value) => literalValue(value)) ||
          Object.hasOwn(operation, "value") ||
          Object.hasOwn(operation, "reference")
        )
          return;
      } else if (Object.hasOwn(operation, "reference")) {
        if (
          !operation.local ||
          typeof operation.reference !== "string" ||
          !locals.has(operation.reference) ||
          Object.hasOwn(operation, "value")
        )
          return;
      } else if (
        !operation.local ||
        !Object.hasOwn(operation, "value") ||
        !literalValue(operation.value)
      )
        return;

      if (operation.local) locals.add(operation.local);
    }

    const exports = new Set<string>();

    for (const entry of program.exports) {
      if (
        !entry ||
        typeof entry.name !== "string" ||
        exports.has(entry.name) ||
        !locals.has(entry.local)
      )
        return;

      exports.add(entry.name);
    }

    return serialize(program) === source ? program : undefined;
  } catch {
    return;
  }
}

/** Called only after whole-program proof, under the normal adapter/registry lease. */
export function executeStaticStyleProgram(
  program: StaticStyleProgram,
  require: NodeRequire
): object {
  const values = new Map<string, unknown>();
  const scope =
    require("@vanilla-extract/css/fileScope") as typeof import("@vanilla-extract/css/fileScope");

  for (const name of program.modules) require(name);

  scope.setFileScope(program.scope.filePath, program.scope.packageName);

  try {
    for (const operation of program.operations) {
      const value = operation.call
        ? require(operation.call.module)[operation.call.name](
            ...structuredClone(operation.call.args)
          )
        : operation.reference
          ? values.get(operation.reference)
          : structuredClone(operation.value);

      if (operation.local) values.set(operation.local, value);
    }

    return Object.fromEntries(
      program.exports.map(({ name, local }) => [name, values.get(local)])
    );
  } finally {
    scope.endFileScope();
  }
}
