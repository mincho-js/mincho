import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build, context } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";

const root = resolve("fixture/modules/compiler-classes");
await mkdir(root, { recursive: true });
await writeFile(
  join(root, "private.tsx"),
  `
  import { defineRules, css } from "@mincho-js/css";
  const owner = defineRules({ properties: { color: true, display: true, opacity: true } });
  const another = defineRules({ properties: { color: true, display: true } });
  const first = css([owner.css({ color: "red", display: "flex" })]);
  const second = css([another.css({ color: "red", display: "flex" })]);
  const solo = css([owner.css({ opacity: 0.5 })]);
  export const First = () => <div data-kind="first" className={first} />;
  export const Second = () => <div data-kind="second" className={second} />;
  export const Solo = () => <span className={solo} />;
`
);
await writeFile(
  join(root, "other.tsx"),
  `
  import { defineRules, css } from "@mincho-js/css";
  const owner = defineRules({ properties: { color: true, display: true } });
  const other = css([owner.css({ color: "red", display: "flex" })]);
  export const Other = () => <div className={other} />;
`
);

const entries = [
  'export { First, Second, Solo } from "./private";',
  'export { Other } from "./other";'
];

await writeFile(join(root, "entry.ts"), entries.join("\n"));
await writeFile(
  join(root, "fallback.tsx"),
  `
  import { defineRules, css } from "@mincho-js/css";
  const owner = defineRules({ properties: { color: true, display: true } });
  export const published = css([owner.css({ color: "red", display: "flex" })]);
  const merged = css([owner.css({ color: "blue", display: "flex" })]);
  export const Public = () => <div className={published} />;
  export const External = () => <div className={"outside " + merged} />;
`
);

const modes = {
  default: undefined,
  disabled: { globalAtomicClasses: false, compileClass: false },
  atomic: { globalAtomicClasses: true },
  compound: { compileClass: true },
  combined: { globalAtomicClasses: true, compileClass: true }
};

const text = (result, extension) =>
  result.outputFiles
    .filter((file) => file.path.endsWith(extension))
    .map((file) => file.text)
    .join("\n");

const atoms = (classes) =>
  classes.split(" ").filter((name) => !name.startsWith("__mincho_seg_"));

let evaluationId = 0;

function options(name, platform, experimental, extra = {}) {
  return {
    absWorkingDir: root,
    entryPoints: ["entry.ts"],
    outdir: join(root, "dist"),
    bundle: true,
    write: false,
    format: "esm",
    platform,
    minify: true,
    jsx: "automatic",
    external: ["react"],
    metafile: true,
    logLevel: "silent",
    plugins: minchoEsbuildPlugins({
      cache: false,
      execution: { workers: 0, evaluation: "fresh" },
      experimental,
      diagnostics: { json: `${name}.diagnostics.json` },
      ...extra
    })
  };
}

async function observe(result) {
  const css = text(result, ".css");
  const rules = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const js = text(result, ".js");
  const file = join(root, `evaluated-${evaluationId++}.mjs`);
  await writeFile(file, js);

  const api = await import(pathToFileURL(file).href);
  const classNames = {};
  const markup = {};

  for (const key of ["First", "Second", "Solo", "Other"]) {
    const element = api[key]();
    classNames[key] = element.props.className;
    markup[key] = renderToStaticMarkup(element);

    // This fixture emits only unconditional class rules. Verify every rendered
    // class combination resolves to the expected declarations in native CSS.
    const declarations = {};

    for (const [, selectors, body] of rules.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (
        !atoms(element.props.className).some((name) =>
          selectors
            .split(",")
            .some((selector) => selector.trim() === `.${name}`)
        )
      )
        continue;

      for (const declaration of body.split(";")) {
        const colon = declaration.indexOf(":");

        if (colon > 0)
          declarations[declaration.slice(0, colon).trim()] = declaration
            .slice(colon + 1)
            .trim();
      }
    }

    if (key === "Solo") assert.equal(Number(declarations.opacity), 0.5);
    else assert.deepEqual(declarations, { color: "red", display: "flex" });
  }

  return { classNames, markup, css, js };
}

const observations = {};

for (const [mode, experimental] of Object.entries(modes)) {
  const clientResult = await build(
    options(`${mode}-client`, "browser", experimental)
  );

  const client = await observe(clientResult);
  const server = await observe(
    await build(options(`${mode}-server`, "node", experimental))
  );

  assert.deepEqual(
    server.classNames,
    client.classNames,
    `${mode}: SSR/client classes`
  );
  assert.deepEqual(server.markup, client.markup, `${mode}: SSR/client markup`);
  assert.equal(server.css, client.css, `${mode}: SSR/client native CSS`);

  observations[mode] = client;

  if (mode === "atomic" || mode === "combined") {
    assert.equal(client.classNames.First, client.classNames.Second);
    assert.notEqual(client.classNames.First, client.classNames.Other);

    for (const value of Object.values(client.classNames))
      assert.ok(
        atoms(value).every((name) => /^m[ac]_[A-Za-z0-9_-]{22}$/.test(name))
      );
  }

  if (mode === "compound" || mode === "combined") {
    assert.equal(client.classNames.First.split(" ").length, 1);
    assert.equal(client.classNames.Second.split(" ").length, 1);
  }

  if (mode !== "default" && mode !== "disabled") {
    assert.doesNotMatch(
      client.js,
      /compilePrivateDefineRulesClass|createDefineRulesRuntime|registerDefineRulesRegistryInstance|setFileScope|appendCss/
    );
    assert.doesNotMatch(
      Object.keys(clientResult.metafile.inputs).join("\n"),
      /compilerClasses|defineRules\/registry|@vanilla-extract\//
    );
  }
}

assert.deepEqual(observations.disabled, observations.default);
assert.equal(atoms(observations.atomic.classNames.First).length, 2);

for (const workers of [0, 1]) {
  const name = `cached-workers-${workers}`;
  const compiler = await context(
    options(name, "browser", modes.combined, {
      cache: { type: "memory" },
      execution: { workers, evaluation: workers === 0 ? "auto" : "fresh" }
    })
  );

  try {
    for (const phase of ["cold", "unchanged"]) {
      const actual = await observe(await compiler.rebuild());

      assert.deepEqual(
        actual,
        observations.combined,
        `workers=${workers}, ${phase}: cached/uncached output`
      );

      if (workers === 1 && phase === "cold") {
        const report = JSON.parse(
          await readFile(join(root, `${name}.diagnostics.json`), "utf8")
        );

        assert.ok(
          report.builds.some((entry) =>
            entry.events.some((event) => event.phase === "worker-run")
          ),
          "Explicit compiler-worker execution must be observed, not silently bypassed"
        );
      }
    }
  } finally {
    await compiler.dispose();
  }
}

await writeFile(join(root, "entry.ts"), entries.toReversed().join("\n"));

const reversed = await observe(
  await build(options("reversed", "browser", modes.combined))
);

assert.deepEqual(reversed.classNames, observations.combined.classNames);
assert.deepEqual(reversed.markup, observations.combined.markup);

await writeFile(join(root, "entry.ts"), entries.join("\n"));

const fallback = (experimental) =>
  build({
    ...options("fallback", "browser", experimental),
    entryPoints: ["fallback.tsx"]
  });

const scopedFallback = await fallback(modes.default);
const optedFallback = await fallback(modes.combined);

assert.equal(text(optedFallback, ".js"), text(scopedFallback, ".js"));
assert.equal(text(optedFallback, ".css"), text(scopedFallback, ".css"));
assert.doesNotMatch(text(optedFallback, ".css"), /\.m[ac]_[A-Za-z0-9_-]{22}/);

const report = Object.fromEntries(
  Object.entries(observations).map(([name, value]) => [
    name,
    { js: Buffer.byteLength(value.js), css: Buffer.byteLength(value.css) }
  ])
);

await writeFile(join(root, "sizes.json"), JSON.stringify(report, null, 2));
console.log(
  `[compiler-classes] SSR/client, fresh/cache, inline/worker and fallback parity passed; fixture bytes ${JSON.stringify(report)}`
);
