import { internalResolveFromModule as resolveFromModule } from "@mincho-js/babel";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fingerprintCompilerDependencies } from "./compilerDependencies.js";
import { CompilationDiskCache, getCompilerIdentity } from "./diskCache.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mincho-compiler-deps-"));
  directories.push(root);
  const writePackage = async (
    name: string,
    version: string,
    dependencies = {}
  ) => {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "index.js"), "export const value = 1;");
    await writeFile(
      join(path, "package.json"),
      JSON.stringify({ name, version, ...dependencies })
    );
    return join(path, "index.js");
  };
  const entry = await writePackage("compiler", "1.0.0", {
    dependencies: { parser: "^1" }
  });
  await writePackage("parser", "1.0.0", {
    dependencies: { traverse: "^1", compiler: "^1" }
  });
  await writePackage("traverse", "1.0.0");
  const resolve: typeof resolveFromModule = (issuer, specifier) => {
    expect(String(issuer).startsWith(root)).toBe(true);
    return join(dirname(dirname(String(issuer))), specifier);
  };
  return { root, entry, writePackage, resolve };
}

it("separates shared cache entries when only a transitive compiler version changes", async () => {
  const first = await fixture();
  const second = await fixture();
  const identity = await fingerprintCompilerDependencies(
    [first.entry],
    first.resolve
  );
  expect(
    await fingerprintCompilerDependencies([second.entry], second.resolve)
  ).toBe(identity);
  await second.writePackage("traverse", "1.1.0");
  const changed = await fingerprintCompilerDependencies(
    [second.entry],
    second.resolve
  );
  expect(changed).not.toBe(identity);
  const cacheDirectory = join(first.root, "cache");
  await new CompilationDiskCache(cacheDirectory, identity).put("compile", {
    value: "old compiler result",
    dependencies: [],
    bytes: 20,
    manifest: { fingerprints: [] }
  });
  expect(
    await new CompilationDiskCache(cacheDirectory, changed).get("compile")
  ).toBeUndefined();
});

it("finds manifests through exported entrypoints when package.json is private", async () => {
  const { entry, root, resolve } = await fixture();
  const expected = await fingerprintCompilerDependencies([entry], resolve);
  expect(
    await fingerprintCompilerDependencies([entry], (_issuer, specifier) => {
      if (specifier.endsWith("/package.json")) {
        throw Object.assign(new Error("Private package manifest"), {
          code: "ERR_PACKAGE_PATH_NOT_EXPORTED"
        });
      }
      return join(root, specifier, "index.js");
    })
  ).toBe(expected);
});

it("records absent optional peers and refuses an incomplete required dependency graph", async () => {
  const { entry, writePackage, resolve } = await fixture();
  const missing: typeof resolveFromModule = (issuer, specifier) => {
    if (specifier.startsWith("optional")) {
      throw Object.assign(new Error("Not installed"), {
        code: "MODULE_NOT_FOUND"
      });
    }
    return resolve(issuer, specifier);
  };
  await writePackage("traverse", "1.0.0", {
    peerDependencies: { optional: "*" },
    peerDependenciesMeta: { optional: { optional: true } }
  });
  const absent = await fingerprintCompilerDependencies([entry], missing);
  await writePackage("optional", "1.0.0");
  expect(await fingerprintCompilerDependencies([entry], resolve)).not.toBe(
    absent
  );
  await writePackage("traverse", "1.0.0", { dependencies: { optional: "*" } });
  await expect(
    fingerprintCompilerDependencies([entry], missing)
  ).rejects.toThrow("Not installed");
});

it("fingerprints the installed compiler graph under strict PnP", async () => {
  await expect(getCompilerIdentity()).resolves.toMatch(/^[a-f0-9]{64}$/);
});

it("handles a subpath-only dependency in a native Node installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "mincho-native-compiler-deps-"));
  directories.push(root);
  const parent = join(root, "compiler");
  const dependency = join(parent, "node_modules", "data");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(parent, "package.json"),
    JSON.stringify({
      name: "compiler",
      version: "1.0.0",
      dependencies: { data: "*" }
    })
  );
  await writeFile(join(parent, "index.js"), 'require("data/values");');
  await writeFile(join(dependency, "values.js"), "module.exports = {};");
  const manifest = {
    name: "data",
    version: "1.0.0",
    exports: { "./values": "./values.js" }
  };
  await writeFile(join(dependency, "package.json"), JSON.stringify(manifest));
  const first = await fingerprintCompilerDependencies([
    join(parent, "index.js")
  ]);
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({ ...manifest, version: "1.1.0" })
  );
  expect(
    await fingerprintCompilerDependencies([join(parent, "index.js")])
  ).not.toBe(first);
});
