import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync, brotliCompressSync } from "node:zlib";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";

const root = resolve("fixture/modules/styled-bundles");
await mkdir(root, { recursive: true });
await writeFile(
  join(root, "package.json"),
  JSON.stringify({ name: "mincho-styled-fixture", sideEffects: true })
);
await writeFile(
  join(root, "component.tsx"),
  `
  import { styled } from "@mincho-js/react";
  globalThis.__minchoComponentEvaluations++;
  export const Button = styled.button({
    base: { color: "red" },
    variants: { size: { large: { padding: 8 }, small: { padding: 4 } }, active: { true: { opacity: 1 } } },
    defaultVariants: { size: "small" },
    compoundVariants: ({ size, active }) => [{ condition: [size.large, active.true], style: { background: "blue" } }]
  });
`
);
await writeFile(
  join(root, "barrel.ts"),
  'export { Button } from "./component";'
);
await writeFile(
  join(root, "entry.tsx"),
  `
  import { Button } from "./barrel";
  export const events = [];
  const record = value => { events.push(value); return value; };
  export const App = () => <Button id={record("id")} size="large" active title={record("title")} className="extra">{record("child")}</Button>;
`
);
await writeFile(
  join(root, "public.tsx"),
  `
  import { Button } from "./barrel";
  export { Button };
  export const App = () => <Button size="large" active className="extra">child</Button>;
  export const Dynamic = size => <Button size={size} />;
  export const Polymorphic = () => <Button as="a" href="/link">link</Button>;
`
);
await writeFile(
  join(root, "dynamic.tsx"),
  `
  import { styled } from "@mincho-js/react";
  const Button = styled.button({
    base: { color: "red" },
    variants: { size: { large: { padding: 8 }, small: { padding: 4 } } },
    defaultVariants: { size: "small" }
  });
  export const App = ({ active }) => <Button size={active ? "large" : "small"} title="label" className="extra">child</Button>;
`
);
await writeFile(
  join(root, "chain.tsx"),
  `
  import { styled } from "@mincho-js/react";
  const Parent = styled.div({
    base: { color: "red" },
    variants: { size: { large: { padding: 8 }, small: { padding: 4 } }, tone: { muted: { opacity: 0.5 } } },
    defaultVariants: { size: "small" }
  });
  const Child = styled(Parent, {
    base: { display: "block" },
    variants: { size: { large: { margin: 8 }, small: { margin: 4 } } },
    defaultVariants: { size: "large" }
  });
  export const App = ({ active }) => <Child size={active ? "large" : "small"} tone="muted" className="extra">child</Child>;
`
);

const text = (result, extension) =>
  result.outputFiles
    .filter((file) => file.path.endsWith(extension))
    .map((file) => file.text)
    .join("\n");

const sizes = (source) => ({
  raw: Buffer.byteLength(source),
  gzip: gzipSync(source).length,
  brotli: brotliCompressSync(source).length
});

const bundle = (format, entry, styledComponents) =>
  build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    write: false,
    outdir: join(root, "dist"),
    format,
    platform: "node",
    minify: true,
    jsx: "automatic",
    external: ["react", "react-dom/server"],
    logLevel: "silent",
    plugins: minchoEsbuildPlugins({ optimize: { styledComponents } })
  });

const evaluate = async (code, format, name) => {
  const file = join(root, `${name}.${format === "esm" ? "mjs" : "cjs"}`);
  await writeFile(file, code);

  const imported = await import(pathToFileURL(file).href);

  return format === "esm" ? imported : imported.default;
};

const countStyledWrappers = (element) => {
  let count = 0;

  while (typeof element.type !== "string") {
    assert.equal(typeof element.type.render, "function");

    element = element.type.render(element.props, null);
    count++;
  }

  return count;
};

globalThis.__minchoComponentEvaluations = 0;

for (const format of ["esm", "cjs"]) {
  const before = globalThis.__minchoComponentEvaluations;
  const baseline = await bundle(format, "entry.tsx", false);
  const optimized = await bundle(format, "entry.tsx", true);

  assert.equal(
    globalThis.__minchoComponentEvaluations,
    before,
    "UI modules must not execute at build time"
  );
  assert.equal(text(optimized, ".css"), text(baseline, ".css"));

  const baselineCode = text(baseline, ".js");
  const optimizedCode = text(optimized, ".js");

  assert.match(baselineCode, /forwardRef/);
  assert.doesNotMatch(
    optimizedCode,
    /forwardRef|defaultVariants|compoundVariants/
  );
  assert.ok(optimizedCode.length < baselineCode.length);

  const original = await evaluate(baselineCode, format, `baseline-${format}`);
  const transformed = await evaluate(
    optimizedCode,
    format,
    `optimized-${format}`
  );

  assert.equal(
    renderToStaticMarkup(createElement(transformed.App)),
    renderToStaticMarkup(createElement(original.App))
  );
  assert.deepEqual(transformed.events, ["id", "title", "child"]);
  assert.deepEqual(transformed.events, original.events);
  assert.equal(
    globalThis.__minchoComponentEvaluations,
    before + 2,
    "Original module effects must remain"
  );

  const published = await bundle(format, "public.tsx", true);

  assert.match(text(published, ".js"), /forwardRef/);

  const api = await evaluate(
    text(published, ".js"),
    format,
    `public-${format}`
  );

  assert.ok(api.Button.$$typeof);
  assert.equal(
    renderToStaticMarkup(createElement(api.App)),
    renderToStaticMarkup(
      createElement(
        api.Button,
        { size: "large", active: true, className: "extra" },
        "child"
      )
    )
  );
  assert.match(renderToStaticMarkup(createElement(api.Polymorphic)), /^<a /);
  assert.match(renderToStaticMarkup(api.Dynamic("small")), /^<button /);

  console.log(
    `[styled-flatten] ${format}: ${JSON.stringify({ baseline: sizes(baselineCode), optimized: sizes(optimizedCode), css: sizes(text(optimized, ".css")) })}`
  );

  for (const [fixture, wrappersBefore, wrappersAfter] of [
    ["dynamic", 1, 0],
    ["chain", 2, 1]
  ]) {
    const baseline = await bundle(format, `${fixture}.tsx`, false);
    const optimized = await bundle(format, `${fixture}.tsx`, true);
    const baselineCode = text(baseline, ".js");
    const optimizedCode = text(optimized, ".js");

    assert.equal(text(optimized, ".css"), text(baseline, ".css"));

    const original = await evaluate(
      baselineCode,
      format,
      `${fixture}-before-${format}`
    );

    const transformed = await evaluate(
      optimizedCode,
      format,
      `${fixture}-after-${format}`
    );

    for (const active of [true, false]) {
      const before = original.App({ active });
      const after = transformed.App({ active });

      assert.equal(countStyledWrappers(before), wrappersBefore);
      assert.equal(countStyledWrappers(after), wrappersAfter);
      assert.equal(renderToStaticMarkup(after), renderToStaticMarkup(before));
    }

    console.log(
      `[styled-${fixture}] ${format}: ${JSON.stringify({ baseline: sizes(baselineCode), optimized: sizes(optimizedCode), wrappersBefore, wrappersAfter })}`
    );
  }
}

delete globalThis.__minchoComponentEvaluations;
