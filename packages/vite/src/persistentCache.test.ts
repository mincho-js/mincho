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

it("revalidates persistent inputs and recreates Vite CSS after a process restart", async () => {
  const parent = join(process.cwd(), ".cache");
  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "persistent-vite-"));
  roots.push(root);
  await mkdir(join(root, "reports"));
  await writeFile(
    join(root, "package.json"),
    '{"name":"persistent-fixture","type":"module"}'
  );
  await writeFile(join(root, "token.ts"), 'export const color = "red";');
  await writeFile(
    join(root, "entry.ts"),
    'import { css } from "@mincho-js/css"; import { color } from "./token"; export const className = css({ color });'
  );

  const script = `
    import { build } from "vite";
    import { minchoVitePlugin } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/esm/index.mjs")).href)};
    const root = process.argv[1];
    const result = await build({
      root,
      configFile: false,
      logLevel: "silent",
      cacheDir: root + "/compiler-cache",
      plugins: [minchoVitePlugin({
        cache: { type: "filesystem" },
        diagnostics: { json: "reports/build.json" },
        libraryCss: { analysis: "inline" }
      })],
      build: {
        write: false,
        cssCodeSplit: true,
        minify: false,
        cssMinify: false,
        lib: { entry: root + "/entry.ts", formats: ["es"] },
        rollupOptions: { external: ["@mincho-js/css"] }
      }
    });
    process.stdout.write(JSON.stringify((Array.isArray(result) ? result : [result]).flatMap(result => result.output).map(file => [file.fileName, file.type === "chunk" ? file.code : file.source])));
  `;

  const run = async () => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "--eval", script, root],
      { cwd: root, timeout: 25_000 }
    );
    const report = JSON.parse(
      await readFile(join(root, "reports/build.json"), "utf8")
    ) as { builds: Array<{ events: Array<{ phase: string }> }> };

    return {
      files: JSON.parse(stdout) as Array<[string, string]>,
      hit: report.builds.some((build) =>
        build.events.some((event) => event.phase === "cache-hit")
      )
    };
  };

  const cold = await run();
  const warm = await run();

  expect(warm.hit).toBe(true);
  expect(warm.files).toEqual(cold.files);
  expect(warm.files.find(([name]) => name.endsWith(".css"))?.[1]).toContain(
    "color: red"
  );

  await writeFile(join(root, "token.ts"), 'export const color = "blue";');

  const changed = await run();

  expect(changed.files.find(([name]) => name.endsWith(".css"))?.[1]).toContain(
    "color: blue"
  );
  expect(changed.files).not.toEqual(warm.files);
}, 90_000);
