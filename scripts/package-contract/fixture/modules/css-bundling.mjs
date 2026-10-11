import assert from "node:assert/strict";
import { join } from "node:path";
import { build as viteBuild } from "vite";
import { build as esbuildBuild } from "esbuild";
import { minchoVitePlugin } from "@mincho-js/vite";
import { buildWithMincho } from "@mincho-js/esbuild";
import {
  buildApp,
  buildLibrary,
  consumeLibrary
} from "../css-bundling/build.mjs";

// This module and the helpers are copied into each isolated npm/PnP consumer.
// All compilers above resolve from its installed tarballs, outside the repo.
const tools = { viteBuild, minchoVitePlugin, buildWithMincho, esbuildBuild };
const root = join(import.meta.dirname, "css-bundling-output");

for (const mode of ["single", "dist-chunk", "routes"]) {
  const result = await buildApp(
    tools,
    join(root, "app", mode),
    "spa",
    "vite",
    mode
  );

  const sheets = [...result.artifacts.files.keys()].filter((id) =>
    id.endsWith(".css")
  );

  if (mode === "single") assert.equal(sheets.length, 1);
  if (mode === "routes")
    assert(sheets.some((id) => id.includes("mincho-shared-")));
}

for (const format of ["es", "cjs"]) {
  const library = join(root, format, "library");
  await buildLibrary(tools, library, "component", format, 3);

  for (const bundler of ["vite", "esbuild"]) {
    for (const method of format === "es" ? ["named", "subpath"] : ["subpath"]) {
      const result = await consumeLibrary(
        tools,
        join(root, format, bundler, method),
        library,
        "component",
        1,
        method,
        bundler,
        format
      );

      assert(
        result.shared,
        `${format}/${bundler}/${method}: missing shared CSS`
      );

      if (bundler === "esbuild" && method === "named") {
        assert(result.components.includes(0));

        console.log(
          `[package-contract] native esbuild named import retained CSS for ${result.components.length} components`
        );
      } else {
        assert.deepEqual(
          result.components,
          [0],
          `${format}/${bundler}/${method}: unrelated component CSS`
        );
      }

      assert.equal(result.navigation.duplicateModules.length, 0);
    }
  }
}

console.log(
  "[package-contract] CSS ownership passed for Vite app modes/routes, Vite ESM named/subpath and Vite/esbuild ESM/CJS subpaths"
);
