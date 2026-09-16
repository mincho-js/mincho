import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { build, createServer, type ViteDevServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { minchoVitePlugin } from "./index.js";

const execute = promisify(execFile);
const roots: string[] = [];
const servers: ViteDevServer[] = [];
const packageName = "@mincho-test/commonjs-runtime";

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  // The temporary consumer uses native Node resolution outside the PnP graph.
  const root = await mkdtemp(join(tmpdir(), "mincho-commonjs-ssr-"));
  roots.push(root);
  const project = join(root, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ name: "ssr-fixture", type: "module" })
  );

  return { root, project };
}

async function installPackage(root: string, value: string) {
  const directory = join(root, "node_modules", packageName);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: packageName,
      exports: {
        ".": { import: "./import.mjs", require: "./index.cjs" },
        "./feature": { import: "./import.mjs", require: "./feature.cjs" }
      }
    })
  );
  await writeFile(
    join(directory, "import.mjs"),
    'export const value = "wrong import condition";'
  );
  for (const entry of ["index", "feature"])
    await writeFile(
      join(directory, `${entry}.cjs`),
      `exports.value = ${JSON.stringify(`${value}:${entry}`)};`
    );
}

async function readValues(entry: string, cwd: string) {
  const { stdout } = await execute(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const { values } = await import(process.argv[1]); process.stdout.write(JSON.stringify(values));",
      pathToFileURL(entry).href
    ],
    { cwd, env: { ...process.env, NODE_OPTIONS: "" } }
  );

  return JSON.parse(stdout);
}

describe("CommonJS dependencies in SSR output", () => {
  it.each(["relative", "absolute"] as const)(
    "reloads %s CommonJS source outside the root after SSR invalidation",
    async (request) => {
      const { root, project } = await fixture();
      const shared = join(root, "shared.cjs");
      await writeFile(shared, 'exports.value = "before";');
      await writeFile(
        join(project, "src/entry.js"),
        `const dependency = require(${JSON.stringify(request === "relative" ? "../../shared.cjs" : shared)}); export const values = dependency.value;`
      );
      const server = await createServer({
        root: project,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin()],
        server: { middlewareMode: true }
      });
      servers.push(server);

      expect((await server.ssrLoadModule("/src/entry.js")).values).toBe(
        "before"
      );
      expect((await server.ssrLoadModule("/src/entry.js")).values).toBe(
        "before"
      );
      await writeFile(shared, 'exports.value = "after";');
      server.watcher.emit("change", shared);
      server.environments.ssr.moduleGraph.invalidateAll();

      expect((await server.ssrLoadModule("/src/entry.js")).values).toBe(
        "after"
      );
      expect((await server.ssrLoadModule("/src/entry.js")).values).toBe(
        "after"
      );
      await rm(shared);
      server.watcher.emit("unlink", shared);
      server.environments.ssr.moduleGraph.invalidateAll();
      await expect(server.ssrLoadModule("/src/entry.js")).rejects.toThrow();
    }
  );

  it.each(["es", "cjs"] as const)(
    "preserves callable Node builtins (%s)",
    async (format) => {
      const { root, project } = await fixture();
      await writeFile(
        join(project, "src/entry.js"),
        'const assert = require("node:assert/strict"); assert(true); export const values = typeof assert;'
      );
      const entry = `entry.${format === "es" ? "mjs" : "cjs"}`;
      await build({
        root: project,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin()],
        build: {
          ssr: join(project, "src/entry.js"),
          outDir: join(root, "deployed"),
          rollupOptions: { output: { format, entryFileNames: entry } }
        }
      });

      expect(await readValues(join(root, "deployed", entry), root)).toBe(
        "function"
      );
    }
  );

  it.each(["es", "cjs"] as const)(
    "supports external JSON requires (%s)",
    async (format) => {
      const { root, project } = await fixture();
      await writeFile(
        join(project, "src/entry.js"),
        'exports.values = require("../data.json").value;'
      );
      await writeFile(
        join(project, "data.json"),
        `\uFEFF${JSON.stringify({ value: "json" })}`
      );
      const entry = `entry.${format === "es" ? "mjs" : "cjs"}`;
      await build({
        root: project,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin()],
        build: {
          ssr: join(project, "src/entry.js"),
          outDir: join(root, "deployed"),
          rollupOptions: {
            external: ["../data.json"],
            output: { format, entryFileNames: entry }
          }
        }
      });

      expect(await readValues(join(root, "deployed", entry), root)).toBe(
        "json"
      );
    }
  );

  it.each(["es", "cjs"] as const)(
    "bundles packages selected by ssr.noExternal (%s)",
    async (format) => {
      const { root, project } = await fixture();
      await installPackage(project, "bundled");
      await writeFile(
        join(project, "src/entry.js"),
        `const dependency = require(${JSON.stringify(packageName)}); export const values = dependency.value;`
      );
      const deployed = join(root, "deployed");
      const entry = `entry.${format === "es" ? "mjs" : "cjs"}`;
      await build({
        root: project,
        configFile: false,
        logLevel: "silent",
        plugins: [
          {
            name: "resolve-runtime-package",
            resolveId(id) {
              if (id === packageName)
                return join(project, "node_modules", packageName, "index.cjs");
            }
          },
          minchoVitePlugin()
        ],
        ssr: { noExternal: [packageName] },
        build: {
          ssr: join(project, "src/entry.js"),
          outDir: deployed,
          rollupOptions: {
            output: { format, entryFileNames: entry }
          }
        }
      });
      await rm(project, { recursive: true, force: true });

      expect(await readValues(join(deployed, entry), root)).toBe(
        "bundled:index"
      );
    }
  );

  it.each(["es", "cjs"] as const)(
    "preserves aliases to external packages (%s)",
    async (format) => {
      const { root, project } = await fixture();
      await installPackage(project, "build");
      await writeFile(
        join(project, "src/entry.js"),
        'const dependency = require("runtime-alias"); export const values = dependency.value;'
      );
      const deployed = join(root, "deployed");
      const entry = `entry.${format === "es" ? "mjs" : "cjs"}`;
      await build({
        root: project,
        configFile: false,
        logLevel: "silent",
        plugins: [
          {
            name: "external-runtime-alias",
            resolveId(id) {
              if (id === "runtime-alias")
                return { id: packageName, external: true };
            }
          },
          minchoVitePlugin()
        ],
        build: {
          ssr: join(project, "src/entry.js"),
          outDir: join(deployed, "server"),
          rollupOptions: {
            output: { format, entryFileNames: entry }
          }
        }
      });
      await installPackage(deployed, "runtime");
      await rm(project, { recursive: true, force: true });

      expect(await readValues(join(deployed, "server", entry), root)).toBe(
        "runtime:index"
      );
    }
  );

  it.each(["es", "cjs"] as const)(
    "loads deployed package exports with require conditions (%s)",
    async (format) => {
      const { root, project } = await fixture();
      await installPackage(project, "build");
      await writeFile(
        join(project, "src/entry.js"),
        `const main = require(${JSON.stringify(packageName)});
         const feature = require(${JSON.stringify(`${packageName}/feature`)});
         export const values = [main.value, feature.value];`
      );
      const deployed = join(root, "deployed");
      const entry = `entry.${format === "es" ? "mjs" : "cjs"}`;
      await build({
        root: project,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin()],
        build: {
          ssr: join(project, "src/entry.js"),
          outDir: join(deployed, "server"),
          rollupOptions: {
            external: [packageName, `${packageName}/feature`],
            output: { format, entryFileNames: entry }
          }
        }
      });
      await installPackage(deployed, "runtime");
      await rm(project, { recursive: true, force: true });

      expect(await readValues(join(deployed, "server", entry), root)).toEqual([
        "runtime:index",
        "runtime:feature"
      ]);
    }
  );

  it.each(["es", "cjs"] as const)(
    "keeps external relative requests tied to their original importer (%s)",
    async (format) => {
      const { root, project } = await fixture();
      await writeFile(
        join(project, "src/entry.js"),
        'const dependency = require("../runtime.cjs"); export const values = dependency.value;'
      );
      await writeFile(
        join(project, "runtime.cjs"),
        'exports.value = "original importer";'
      );
      await mkdir(join(project, "dist"));
      await writeFile(
        join(project, "dist/runtime.cjs"),
        'exports.value = "wrong bundle-relative target";'
      );
      const entry = `entry.${format === "es" ? "mjs" : "cjs"}`;
      await build({
        root: project,
        configFile: false,
        logLevel: "silent",
        plugins: [minchoVitePlugin()],
        build: {
          ssr: join(project, "src/entry.js"),
          outDir: join(project, "dist/server"),
          rollupOptions: {
            external: ["../runtime.cjs"],
            output: { format, entryFileNames: entry }
          }
        }
      });

      expect(await readValues(join(project, "dist/server", entry), root)).toBe(
        "original importer"
      );
    }
  );
});
