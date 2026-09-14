import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { build as esbuild } from "esbuild";
import { build as vite } from "vite";
import { minchoVitePlugin } from "@mincho-js/vite";

const root = join(import.meta.dirname, "library-css-output");

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

async function produce(format) {
  const library = join(root, format, "library");
  const extension = format === "es" ? "mjs" : "cjs";
  const files = {
    "package.json": JSON.stringify({
      name: "native-library-css-fixture",
      type: "module",
      sideEffects: ["**/*.css"]
    }),
    "index.js":
      'export { button } from "./button.js"; export { modal } from "./modal.js";',
    "shared.js": 'import "./shared.css"; export const base = "shared";',
    "shared.css": ".shared { color: red; }",
    "pure.css": ".pure { padding: 4px; }",
    "button.css": ".button { color: blue; }",
    "modal.css": ".modal { color: green; }"
  };

  for (const [name, color] of [
    ["button", "blue"],
    ["modal", "green"]
  ]) {
    files[`${name}.js`] = [
      'import { css } from "@mincho-js/css";',
      'import { base } from "./shared.js";',
      'import "./pure.css";',
      `import "./${name}.css";`,
      `const extracted = css({ borderColor: ${JSON.stringify(color)} });`,
      `export const ${name} = base + " ${name} pure " + extracted;`
    ].join("\n");
  }

  for (const [file, contents] of Object.entries(files)) {
    await write(join(library, file), contents);
  }

  await vite({
    root: library,
    configFile: false,
    logLevel: "silent",
    plugins: [minchoVitePlugin()],
    build: {
      cssCodeSplit: true,
      minify: false,
      cssMinify: false,
      sourcemap: true,
      lib: {
        entry: Object.fromEntries(
          ["index", "button", "modal"].map((name) => [
            name,
            join(library, `${name}.js`)
          ])
        ),
        formats: [format]
      },
      rollupOptions: {
        output: {
          manualChunks: (id) => (id.endsWith("/pure.css") ? "pure" : undefined),
          entryFileNames: `[name].${extension}`,
          chunkFileNames: `chunks/[name]-[hash].${extension}`,
          assetFileNames: "assets/[name]-[hash][extname]"
        }
      }
    }
  });

  if (format === "es") {
    // This separate pure barrel has no aggregate CSS import. It isolates the
    // consumer's native named-import behavior from Mincho's entry aggregation.
    await write(
      join(library, "dist/pure-barrel.mjs"),
      'export { button } from "./button.mjs"; export { modal } from "./modal.mjs";'
    );
  }

  return { library, extension };
}

async function consume(library, entry, bundler) {
  const app = join(library, `consumer-${bundler}.js`);
  await write(
    app,
    `import { button } from "./dist/${entry}"; console.log(button);`
  );

  if (bundler === "esbuild") {
    const result = await esbuild({
      entryPoints: [app],
      bundle: true,
      format: "esm",
      outdir: join(library, "consumer-dist"),
      write: false,
      logLevel: "silent"
    });

    return result.outputFiles
      .filter((file) => file.path.endsWith(".css"))
      .map((file) => file.text)
      .join("\n");
  }

  const result = await vite({
    root: library,
    configFile: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      cssMinify: false,
      commonjsOptions: { include: [/\.cjs$/, /node_modules/] },
      rollupOptions: { input: app }
    }
  });

  return (Array.isArray(result) ? result : [result])
    .flatMap((output) => output.output)
    .filter((file) => file.type === "asset" && file.fileName.endsWith(".css"))
    .map((file) => String(file.source))
    .join("\n");
}

for (const format of ["es", "cjs"]) {
  const { library, extension } = await produce(format);

  for (const bundler of ["vite", "esbuild"]) {
    const css = await consume(library, `button.${extension}`, bundler);
    const label = `${format}/${bundler}`;

    assert.match(css, /\.button\s*\{/, label);
    assert.match(css, /\.pure\s*\{/, label);
    assert.match(css, /border-color:\s*blue/, label);
    assert.doesNotMatch(css, /\.modal\s*\{|border-color:\s*green/, label);
    assert.equal(css.match(/\.shared\s*\{/g)?.length, 1, label);
    assert.ok(css.indexOf(".shared") < css.indexOf(".button"), label);
  }

  if (format === "es") {
    const named = await consume(library, "pure-barrel.mjs", "esbuild");
    assert.match(named, /\.button\s*\{/);
    assert.match(named, /\.modal\s*\{/);
    console.log(
      "[package-contract] native esbuild named imports retain unused component CSS"
    );
  }
}

console.log(
  "[package-contract] Vite/esbuild ESM/CJS component CSS and dependency order passed"
);
