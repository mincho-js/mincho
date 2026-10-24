import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build as viteBuild } from "vite";
import { build as esbuild } from "esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";

const root = resolve(".");
const output = { css: {}, rscBuild: {} };

for (const mode of ["native", "dist-chunk"]) {
  const dir = join(root, "css-" + mode);
  await mkdir(dir, { recursive: true });

  const files = {
    "index.html":
      '<!doctype html><html><head></head><body><div id="target">probe</div><script type="module" src="/main.js"></script></body></html>',
    "layout.js":
      "import {css} from '@mincho-js/css'; export const shared=css({padding:7});",
    "route-a.js":
      "import {css} from '@mincho-js/css'; import {shared} from './layout.js'; const own=css({color:'red'}); export const className=shared+' '+own;",
    "route-b.js":
      "import {css} from '@mincho-js/css'; import {shared} from './layout.js'; const own=css({color:'blue'}); export const className=shared+' '+own;",
    "main.js":
      "globalThis.routes={a:()=>import('./route-a.js'),b:()=>import('./route-b.js')};"
  };

  for (const [name, source] of Object.entries(files))
    await writeFile(join(dir, name), source);

  const result = await viteBuild({
    root: dir,
    configFile: false,
    logLevel: "silent",
    base: "/app/",
    plugins: [
      minchoVitePlugin({
        appCss: {
          mode,
          routes: [
            { id: "a", entry: "route-a.js", layouts: ["layout.js"] },
            { id: "b", entry: "route-b.js", layouts: ["layout.js"] }
          ]
        }
      })
    ],
    build: { outDir: "dist", minify: false, manifest: true, ssrManifest: true }
  });

  const assets = (Array.isArray(result) ? result : [result]).flatMap(
    (x) => x.output
  );

  const manifest = JSON.parse(
    await readFile(join(dir, "dist/.vite/manifest.json"), "utf8")
  );

  const ssrManifest = JSON.parse(
    await readFile(join(dir, "dist/.vite/ssr-manifest.json"), "utf8")
  );

  function cssFor(key, seen = new Set()) {
    if (seen.has(key)) return [];

    seen.add(key);

    const chunk = manifest[key];

    return [
      ...new Set([
        ...(chunk?.css ?? []),
        ...(chunk?.imports ?? []).flatMap((x) => cssFor(x, seen))
      ])
    ];
  }

  output.css[mode] = {
    manifest,
    ssrManifest,
    routeACss: cssFor("route-a.js"),
    routeBCss: cssFor("route-b.js"),
    chunks: assets
      .filter((x) => x.type === "chunk")
      .map((x) => ({
        file: x.fileName,
        imports: x.imports,
        modules: Object.keys(x.modules),
        css: [...(x.viteMetadata?.importedCss ?? [])]
      }))
  };
}

const rsc = join(root, "rsc");
const sources = {
  local:
    "import {styled} from '@mincho-js/react'; const Box=styled.div({base:{color:'red'},variants:{size:{small:{padding:4},large:{padding:8}}}}); export const App=({size})=><Box size={size==='large'?'large':'small'}>child</Box>;",
  exported:
    "import {styled} from '@mincho-js/react'; export const Box=styled.div({base:{color:'red'},variants:{size:{small:{padding:4},large:{padding:8}}}}); export const App=({size,as})=><Box size={size} as={as}>child</Box>;",
  cssProp:
    "/** @jsxImportSource @mincho-js/react */ export const App=()=> <div css={{color:'red'}}>child</div>;",
  clientDirective:
    "'use client'; import {styled} from '@mincho-js/react'; export const Box=styled.div({color:'red'});"
};

for (const [name, source] of Object.entries(sources)) {
  const src = join(root, name + ".tsx");
  await writeFile(src, source);

  const result = await esbuild({
    entryPoints: [src],
    bundle: true,
    outdir: join(rsc, name),
    write: true,
    format: "esm",
    platform: "node",
    jsx: "automatic",
    external: ["react", "react/*"],
    logLevel: "silent",
    plugins: minchoEsbuildPlugins({
      jsxCssProp: true,
      optimize: { styledComponents: true }
    })
  });

  const code = await readFile(join(rsc, name, name + ".js"), "utf8");
  output.rscBuild[name] = {
    hasForwardRef: code.includes("forwardRef"),
    clientDirectivePreserved: /^\s*["']use client["']/.test(code),
    bytes: Buffer.byteLength(code)
  };
}

await esbuild({
  entryPoints: [join(root, "memo-entry.js")],
  bundle: true,
  outfile: join(root, "browser/memo.js"),
  format: "esm",
  platform: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' }
});
await writeFile(
  join(root, "build-results.json"),
  JSON.stringify(output, null, 2)
);
console.log(JSON.stringify(output, null, 2));
