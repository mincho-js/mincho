import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "vite";
import { minchoVitePlugin } from "@mincho-js/vite";

const root = resolve(".");
const results = { order: {} };

for (const mode of ["native", "dist-chunk"]) {
  const dir = join(root, "css-order-" + mode);
  await mkdir(dir, { recursive: true });

  const files = {
    "index.html":
      '<!doctype html><div id="target" class="order">order</div><script type="module" src="/main.js"></script>',
    "main.js":
      "globalThis.routes={a:()=>import('./route-a.js'),b:()=>import('./route-b.js')};",
    "layout.js":
      "import {css,globalCss} from '@mincho-js/css'; globalCss('.order',{backgroundColor:'green'});export const shared=css({padding:7});",
    "route-a.js":
      "import {css,globalCss} from '@mincho-js/css';import {shared} from './layout.js';globalCss('.order',{backgroundColor:'red'});export const className=shared+' '+css({color:'red'});",
    "route-b.js":
      "import {css,globalCss} from '@mincho-js/css';import {shared} from './layout.js';globalCss('.order',{backgroundColor:'blue'});export const className=shared+' '+css({color:'blue'});"
  };

  for (const [name, text] of Object.entries(files))
    await writeFile(join(dir, name), text);

  await build({
    root: dir,
    base: "/app/",
    configFile: false,
    logLevel: "silent",
    plugins: [minchoVitePlugin({ appCss: { mode } })],
    build: { manifest: true, minify: false }
  });

  const manifest = JSON.parse(
    await readFile(join(dir, "dist/.vite/manifest.json"), "utf8")
  );

  const collect = (key, dependenciesFirst) => {
    const entry = manifest[key];
    const own = entry?.css ?? [];
    const deps = (entry?.imports ?? []).flatMap((k) =>
      collect(k, dependenciesFirst)
    );

    return [
      ...new Set(dependenciesFirst ? [...deps, ...own] : [...own, ...deps])
    ];
  };

  results.order[mode] = {
    routeFirst: collect("route-a.js", false),
    dependenciesFirst: collect("route-a.js", true)
  };
}

const warnings = [];
const result = await build({
  root,
  configFile: false,
  logLevel: "silent",
  plugins: [minchoVitePlugin()],
  build: {
    write: false,
    cssCodeSplit: true,
    lib: { entry: join(root, "clientDirective.tsx"), formats: ["es"] },
    rollupOptions: {
      external: ["react", "react/jsx-runtime"],

      onwarn: (w) => warnings.push({ code: w.code, message: w.message })
    }
  }
});

const assets = (Array.isArray(result) ? result : [result]).flatMap(
  (x) => x.output
);

results.libraryClientDirective = {
  warnings,
  chunks: assets
    .filter((x) => x.type === "chunk")
    .map((x) => ({
      file: x.fileName,
      hasDirective: /["']use client["']/.test(x.code),
      firstLines: x.code.split("\n").slice(0, 4)
    }))
};
await writeFile("extra-results.json", JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
