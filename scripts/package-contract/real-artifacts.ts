import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { installedPackageDirectory, jsSources } from "./artifact-sources.js";
import { assertNoRuntimeGraph } from "./diamond-artifacts.js";
import { assertBrowserCss } from "./browser.js";
import { parseDefineRulesPresetArtifactV5 } from "@mincho-js/css/defineRules/registry";

export async function assertRealBuildArtifacts(
  consumerRoot: string
): Promise<void> {
  const classes: Record<string, string> = {};
  const registeredClasses = new Set<string>();

  for (const name of ["a", "b", "c", "d"]) {
    const root = installedPackageDirectory(
      consumerRoot,
      `@mincho-js-proof/real-${name}`
    );

    const source = await readFile(join(root, "dist/index.js"), "utf8");
    const value = source.match(/export const className = ("[^"]*");/)?.[1];

    assert.ok(value, `Missing real-${name} runtime class`);

    classes[name] = JSON.parse(value) as string;

    // This generated fixture exports a single JSON literal; validate its content
    // and take CSS classes from Atoms, not opaque cx segment markers.
    const presetSource = await readFile(join(root, "dist/preset.js"), "utf8");
    const prefix = "export const preset = ";

    assert.ok(presetSource.startsWith(prefix));

    const preset = parseDefineRulesPresetArtifactV5(
      JSON.parse(presetSource.slice(prefix.length).trim().replace(/;$/, ""))
    );

    for (const node of preset.nodes)
      for (const atom of node.atoms) registeredClasses.add(atom.className);
  }

  const reports = [];

  for (const bundler of ["esbuild", "vite"]) {
    for (const minified of [false, true]) {
      const directory = join(
        consumerRoot,
        "fixture",
        "real",
        `dist-${bundler}${minified ? "-minified" : ""}`
      );

      const cssFiles = (
        await readdir(directory, { recursive: true, withFileTypes: true })
      )
        .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
        .map((entry) => join(entry.parentPath, entry.name));

      // Use the native entry's CSS ownership. A dynamic chunk can emit another
      // stylesheet containing shared rules; do not merge independent outputs.
      let cssFile: string;
      let entryFile: string;

      if (bundler === "esbuild") {
        const metadata = JSON.parse(
          await readFile(
            join(
              consumerRoot,
              "fixture",
              "real",
              `esbuild${minified ? "-minified" : ""}-metafile.json`
            ),
            "utf8"
          )
        ) as {
          outputs: Record<string, { entryPoint?: string; cssBundle?: string }>;
        };

        const entry = Object.entries(metadata.outputs).find(([, output]) =>
          output.entryPoint?.endsWith("src/index.ts")
        );

        assert.ok(
          entry?.[1].cssBundle,
          "Native esbuild entry has no CSS bundle"
        );

        entryFile = resolve(consumerRoot, "fixture", "real", entry[0]);
        cssFile = resolve(consumerRoot, "fixture", "real", entry[1].cssBundle);
      } else {
        const manifest = JSON.parse(
          await readFile(join(directory, ".vite/manifest.json"), "utf8")
        ) as Record<
          string,
          { file: string; isEntry?: boolean; css?: string[] }
        >;

        const entry = Object.values(manifest).find((output) => output.isEntry);

        assert.equal(
          entry?.css?.length,
          1,
          "Fixture's native Vite entry CSS ownership changed"
        );

        entryFile = join(directory, entry!.file);
        cssFile = join(directory, entry!.css![0]!);
      }

      assert.ok(cssFiles.includes(cssFile));

      // Vite preserves a CSS import in its runtime entry. Read exports through
      // a native probe that ignores CSS; the browser loads the real CSS below.
      const { build } = createRequire(join(consumerRoot, "package.json"))(
        "esbuild"
      );

      const probe = await build({
        absWorkingDir: consumerRoot,
        entryPoints: [entryFile],
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        loader: { ".css": "empty" },
        logLevel: "silent"
      });

      assert.equal(probe.outputFiles.length, 1);

      const emitted = (await import(
        `data:text/javascript;base64,${Buffer.from(probe.outputFiles[0].text).toString("base64")}`
      )) as Record<string, unknown>;

      for (const name of ["b", "c", "d"])
        assert.equal(
          emitted[name],
          classes[name],
          `${bundler}: emitted ${name} runtime class changed`
        );

      const localClassName = emitted.local;

      assert.ok(
        typeof localClassName === "string" && localClassName.length > 0,
        `${bundler}: emitted entry has no local runtime class`
      );

      const bytes = await readFile(cssFile);
      const css = bytes.toString("utf8");
      const localClasses = new Set(localClassName.split(/\s+/));

      // The fixture emits plain class selectors. Inspect their declarations so
      // a class mentioned only in a source comment cannot satisfy this check.
      const localRule = [
        ...css
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .matchAll(/([^{}]+)\{([^{}]*)\}/g)
      ].some(
        ([, selectors, declarations]) =>
          selectors!.split(",").some((selector) => {
            const value = selector.trim();

            return value.startsWith(".") && localClasses.has(value.slice(1));
          }) && /(?:^|;)\s*margin\s*:\s*2px\s*(?:;|$)/.test(declarations!)
      );

      assert.ok(
        localRule,
        `${bundler}: emitted local class has no margin:2px rule`
      );

      for (const token of registeredClasses) {
        assert.ok(
          css.includes(`.${token}`),
          `${bundler}: lost existing class ${token}`
        );
      }

      assert.equal(
        css.match(/padding:\s*4px\b/g)?.length,
        1,
        "Shared ancestor must emit padding only once"
      );

      const redRules = css.match(/color:\s*red\b/g)?.length ?? 0;

      assert.ok(
        redRules >= 1 && redRules <= 2,
        `${bundler}: unexpected duplicate-rule count ${redRules}`
      );

      if (!minified)
        assert.equal(
          redRules,
          2,
          "B/C must independently retain their red classes"
        );

      for (const output of await jsSources(directory))
        assertNoRuntimeGraph(output.source, `${bundler}/${output.label}`);

      for (const output of cssFiles.sort()) {
        const outputBytes = await readFile(output);
        reports.push({
          bundler,
          minified,
          file: relative(directory, output),
          primary: output === cssFile,
          redRules:
            outputBytes.toString("utf8").match(/color:\s*red\b/g)?.length ?? 0,
          raw: outputBytes.length,
          gzip: gzipSync(outputBytes, { level: 9 }).length,
          brotli: brotliCompressSync(outputBytes, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
          }).length
        });
      }

      await assertBrowserCss({
        consumerRoot,
        cssFile,
        classes: {
          b: classes.b!,
          c: classes.c!,
          d: classes.d!,
          local: localClassName
        }
      });
    }
  }

  await writeFile(
    join(consumerRoot, "real-css-sizes.json"),
    `${JSON.stringify(reports, null, 2)}\n`
  );
  console.log(
    `[package-contract] Real producer CSS: ${JSON.stringify(reports)}`
  );
}
