import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import { minchoVitePlugin } from "./index.js";

const roots: string[] = [];
const servers: ViteDevServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("CommonJS dependencies in browser development", () => {
  it("uses explicitly included require entries when dependency discovery is disabled", async () => {
    const fixtureRoot = resolve(process.cwd(), ".cache");
    await mkdir(fixtureRoot, { recursive: true });
    const root = await mkdtemp(join(fixtureRoot, "mincho-commonjs-client-"));
    roots.push(root);
    const requireEntry = createRequire(
      join(process.cwd(), "package.json")
    ).resolve("@mincho-js/css");
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/entry.js"),
      'const dependency = require("@mincho-js/css"); export const values = typeof dependency.style;'
    );
    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [minchoVitePlugin()],
      optimizeDeps: { noDiscovery: true, include: [requireEntry] },
      server: { middlewareMode: true }
    });
    servers.push(server);
    const transformed = await server.transformRequest("/src/entry.js");

    expect(transformed?.code).toContain("/node_modules/.vite/deps/");
    expect(transformed?.code).not.toContain("mincho-commonjs-runtime:");
  });
});
