import assert from "node:assert/strict";
import { join, relative } from "node:path";
import {
  appFiles,
  libraryFiles,
  libraryEntries,
  writeFiles
} from "./fixtures.mjs";
import {
  viteArtifacts,
  esbuildArtifacts,
  closure,
  visitReport
} from "./measure.mjs";

export async function saveArtifacts(directory, artifacts) {
  await writeFiles(directory, Object.fromEntries(artifacts.files));
}

export async function buildApp(tools, root, kind, bundler, mode) {
  await writeFiles(root, appFiles(kind));

  const outdir = join(root, "dist");
  let artifacts;
  let buildMs;

  if (bundler === "vite") {
    const start = performance.now();
    const result = await tools.viteBuild({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        tools.minchoVitePlugin({
          cache: false,
          appCss: {
            mode:
              mode === "single"
                ? "single"
                : mode === "native"
                  ? "native"
                  : "dist-chunk",
            sharing: mode === "shared" || mode === "routes",
            ...(mode === "routes"
              ? {
                  routes: ["a", "b"].map((id) => ({
                    id,
                    entry: `${id}.js`,
                    layouts: ["layout.js"]
                  }))
                }
              : {})
          }
        })
      ],
      build: {
        outDir: outdir,
        write: false,
        manifest: true,
        rollupOptions: {
          input:
            kind === "spa"
              ? join(root, "index.html")
              : { a: join(root, "a.html"), b: join(root, "b.html") }
        }
      }
    });

    buildMs = performance.now() - start;
    artifacts = viteArtifacts(result);
  } else {
    const start = performance.now();
    const result = await tools.buildWithMincho({
      absWorkingDir: root,
      entryPoints: kind === "spa" ? ["main.js"] : ["a.js", "b.js"],
      outdir,
      format: "esm",
      splitting: true,
      minify: true,
      write: false,
      metafile: true,
      logLevel: "silent",
      mincho: {
        cache: false,
        experimental: { cssChunkSharing: mode === "shared" }
      }
    });

    buildMs = performance.now() - start;
    if (mode === "shared") {
      const manifest = result.minchoCssManifest;
      assert(manifest, "Explicit esbuild CSS sharing must publish a manifest");

      if (kind === "mpa") {
        const a = manifest.entries["a.js"];
        const b = manifest.entries["b.js"];
        assert(a && b, "The MPA CSS manifest must include both entries");
        assert(
          a.css.some((file) => b.css.includes(file)),
          "The MPA sharing fixture must reuse CSS across entries"
        );
      }
    }

    artifacts = esbuildArtifacts(
      result,
      root,
      outdir,
      kind === "spa" ? ["main.js"] : ["a.js", "b.js"]
    );

    for (const name of kind === "spa" ? ["main"] : ["a", "b"]) {
      const entry = artifacts.entries.get(`${name}.js`);
      const css = [...closure(artifacts, entry)].filter((id) =>
        id.endsWith(".css")
      );

      artifacts.files.set(
        kind === "spa" ? "index.html" : `${name}.html`,
        Buffer.from(
          `<!doctype html><html><head><meta charset="utf-8">${css.map((file) => `<link rel="stylesheet" href="/${file}">`).join("")}</head><body><div id="sample" class="home"></div><pre id="result"></pre><script type="module" src="/${entry}"></script></body></html>`
        )
      );
    }
  }

  await saveArtifacts(outdir, artifacts);

  const sequence =
    kind === "mpa"
      ? bundler === "vite"
        ? ["a.html", "b.html", "a.html"]
        : ["a.js", "b.js", "a.js"]
      : [bundler === "vite" ? "index.html" : "main.js", "a.js", "b.js", "a.js"];

  const navigation = visitReport(artifacts, sequence);
  const reverse = visitReport(
    artifacts,
    kind === "mpa"
      ? [sequence[1], sequence[0], sequence[1]]
      : [sequence[0], sequence[2], sequence[1], sequence[2]]
  );

  if (kind === "spa" && bundler === "vite" && mode !== "single") {
    const initialCss = [...closure(artifacts, "index.html")]
      .filter((file) => file.endsWith(".css"))
      .map((file) => artifacts.files.get(file).toString())
      .join("\n");

    assert(!initialCss.includes("--bench-module-a:"));
    assert(!initialCss.includes("--bench-module-b:"));
  }

  return { artifacts, outdir, navigation, reverse, buildMs };
}

export async function buildLibrary(
  tools,
  root,
  layout,
  format = "es",
  count = 12,
  mode
) {
  await writeFiles(root, libraryFiles(count));

  const extension = format === "es" ? "mjs" : "cjs";
  const single = layout === "single";
  const result = await tools.viteBuild({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [
      tools.minchoVitePlugin({
        cache: false,
        libraryCss: {
          ...(single ? { fileName: "style.css" } : {}),
          ...(mode ? { mode } : {})
        }
      })
    ],
    build: {
      write: false,
      minify: false,
      cssCodeSplit: single ? false : true,
      lib: {
        entry: libraryEntries(root, layout, count),
        formats: [format],
        cssFileName: "style"
      },
      rollupOptions: {
        output: {
          entryFileNames: `[name].${extension}`,
          chunkFileNames: `chunks/[name]-[hash].${extension}`,
          assetFileNames: single ? "style.css" : "assets/[name]-[hash][extname]"
        }
      }
    }
  });

  const artifacts = viteArtifacts(result);
  await saveArtifacts(join(root, "dist"), artifacts);

  return artifacts;
}

export async function consumeLibrary(
  tools,
  root,
  library,
  layout,
  usage,
  method,
  bundler,
  format = "es"
) {
  const extension = format === "es" ? "mjs" : "cjs";
  const imports = Array.from({ length: usage }, (_, i) => {
    const name =
      method === "named"
        ? "index"
        : layout === "group"
          ? `group${Math.floor(i / 4)}`
          : `component${i}`;

    const source = `./${relative(root, join(library, "dist", `${name}.${extension}`)).replaceAll("\\", "/")}`;

    return `import { component${i} } from ${JSON.stringify(source)};`;
  });

  await writeFiles(root, {
    "package.json": JSON.stringify({
      name: "css-benchmark-consumer",
      type: "module",
      sideEffects: true
    }),
    "app.js": `${imports.join("\n")}\nconsole.log(${Array.from({ length: usage }, (_, i) => `component${i}`).join(",")});`
  });

  const outdir = join(root, "dist");
  let artifacts;
  let buildMs;

  if (bundler === "vite") {
    const start = performance.now();
    const result = await tools.viteBuild({
      root,
      configFile: false,
      logLevel: "silent",
      build: {
        write: false,
        manifest: true,
        commonjsOptions: { include: [/\.cjs$/, /node_modules/] },
        rollupOptions: { input: join(root, "app.js") }
      }
    });

    buildMs = performance.now() - start;
    artifacts = viteArtifacts(result);
  } else {
    const start = performance.now();
    const result = await tools.esbuildBuild({
      absWorkingDir: root,
      entryPoints: ["app.js"],
      outdir,
      format: "esm",
      splitting: true,
      bundle: true,
      write: false,
      metafile: true,
      minify: true,
      logLevel: "silent"
    });

    buildMs = performance.now() - start;
    artifacts = esbuildArtifacts(result, root, outdir);
  }

  const navigation = visitReport(artifacts, ["app.js"]);
  const css = [...closure(artifacts, "app.js")]
    .filter((file) => file.endsWith(".css"))
    .map((file) => artifacts.files.get(file).toString())
    .join("\n");

  const components = [
    ...new Set(
      [...css.matchAll(/--bench-module-component(\d+)\s*:/g)].map((m) =>
        Number(m[1])
      )
    )
  ].sort((a, b) => a - b);

  return {
    artifacts,
    navigation,
    components,
    buildMs,
    shared: css.includes("--bench-module-shared:")
  };
}
