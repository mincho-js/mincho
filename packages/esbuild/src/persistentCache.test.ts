import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

it.each(["esm/index.mjs", "cjs/index.cjs"])(
  "restores compiled CSS and native assets in a new process through %s",
  async (entry) => {
    const parent = join(process.cwd(), ".cache");
    await mkdir(parent, { recursive: true });

    const root = await mkdtemp(join(parent, "persistent-esbuild-"));
    roots.push(root);
    await mkdir(join(root, "reports"));
    await writeFile(
      join(root, "package.json"),
      '{"name":"persistent-fixture"}'
    );
    await writeFile(
      join(root, "entry.ts"),
      'import { css } from "@mincho-js/css"; import image from "./icon.png?url"; export const className = css({ backgroundImage: `url("${image}")` });'
    );
    await writeFile(join(root, "icon.png"), "original asset");

    const script = `
      import { build } from "esbuild";
      import { minchoEsbuildPlugins } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist", entry)).href)};
      const root = process.argv[1];
      const result = await build({
        absWorkingDir: root,
        entryPoints: ["entry.ts"],
        outdir: root + "/out",
        bundle: true,
        write: false,
        metafile: true,
        format: "esm",
        logLevel: "silent",
        external: ["@mincho-js/css"],
        loader: { ".png": "file" },
        plugins: minchoEsbuildPlugins({
          cache: { type: "filesystem" },
          diagnostics: { json: "reports/build.json" }
        })
      });
      process.stdout.write(JSON.stringify(result.outputFiles.map(file => [file.path, file.text])));
    `;

    const run = async () => {
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "--eval", script, root],
        { cwd: root, timeout: 25_000 }
      );
      const report = JSON.parse(
        await readFile(join(root, "reports/build.json"), "utf8")
      ) as {
        builds: Array<{
          events: Array<{ phase: string; detail?: { key?: string } }>;
        }>;
      };

      return {
        files: JSON.parse(stdout) as Array<[string, string]>,
        hits: report.builds
          .flatMap((build) => build.events)
          .filter((event) => event.phase === "cache-hit")
          .map((event) => event.detail?.key)
      };
    };

    const cold = await run();
    const warm = await run();

    expect(warm.files).toEqual(cold.files);
    expect(warm.hits, "validated transform and sidecar hits").toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^transform:/),
        expect.stringMatching(/^compile:/)
      ])
    );
    expect(
      warm.files.some(
        ([path, text]) =>
          path.endsWith(".css") && text.includes("background-image")
      )
    ).toBe(true);
    expect(warm.files.find(([path]) => path.endsWith(".png"))?.[1]).toBe(
      "original asset"
    );

    await writeFile(join(root, "icon.png"), "modified asset");

    const changed = await run();

    expect(changed.files).not.toEqual(warm.files);
    expect(changed.files.find(([path]) => path.endsWith(".png"))?.[1]).toBe(
      "modified asset"
    );
  },
  90_000
);
