import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CompilationCache } from "./compilationCache.js";

describe("compilation input sessions", () => {
  it("checks a concurrent caller's inputs before sharing completed work", async () => {
    const cache = new CompilationCache();
    let valid = true;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });

    const create = vi.fn(async () => {
      await ready;

      return {
        value: create.mock.calls.length,
        dependencies: [],
        bytes: 1,

        valid: async () => valid
      };
    });

    const first = cache.run("shared", create);
    const second = cache.run("shared", create);
    valid = false;
    finish();

    expect(await first).toBe(1);
    expect(await second).toBe(2);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("shares concurrent reads and fingerprints, but refreshes every build", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-inputs-"));

    try {
      const file = join(root, "tokens.ts");
      await writeFile(file, "export const color = 'red';");

      const reader = vi.fn((file: string) => readFile(file));
      const cache = new CompilationCache();
      cache.begin(reader);

      const [first, second] = await Promise.all([
        cache.fingerprint([file, file]),
        cache.fingerprint([file])
      ]);

      expect(first).toEqual(second);
      expect(Buffer.from(await cache.readFile(file)).toString()).toContain(
        "red"
      );
      expect(reader).toHaveBeenCalledTimes(1);

      await cache.end();

      await writeFile(file, "export const color = 'tan';");
      cache.begin(reader);

      expect(await cache.unchanged(first)).toBe(false);
      expect(reader).toHaveBeenCalledTimes(2);

      await cache.end();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checks same-mtime edits at publication and discards uncommitted entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-inputs-"));

    try {
      const file = join(root, "tokens.ts");
      await writeFile(file, "red");

      const before = await stat(file);
      const cache = new CompilationCache();
      cache.begin();

      const fingerprints = await cache.fingerprint([file]);
      const create = vi.fn(async () => ({
        value: 1,
        owner: file,
        dependencies: [file],
        bytes: 1,

        valid: () => cache.unchanged(fingerprints)
      }));

      await cache.run("tokens", create);
      await writeFile(file, "tan");
      await utimes(file, before.atime, before.mtime);

      await expect(cache.end()).rejects.toThrow(
        "inputs changed during compilation"
      );

      cache.begin();
      await cache.run("tokens", create);

      expect(create).toHaveBeenCalledTimes(2);

      await cache.end();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("detects configuration creation and deletion in standalone calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-inputs-"));

    try {
      const file = join(root, "babel.config.json");
      const cache = new CompilationCache();

      await expect(
        cache.withInputs(async () => {
          await cache.fingerprint([file]);
          await writeFile(file, "{}");
        })
      ).rejects.toThrow("inputs changed during compilation");
      await expect(
        cache.withInputs(async () => {
          await cache.fingerprint([file]);
          await rm(file);
        })
      ).rejects.toThrow("inputs changed during compilation");
      await expect(
        cache.withInputs(() => cache.fingerprint([file]))
      ).resolves.toEqual(new Map([[file, null]]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows native output directory creation without retaining its old fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-inputs-"));

    try {
      const cache = new CompilationCache();
      cache.begin();
      await cache.fingerprint([root]);

      const create = vi.fn(async () => ({
        value: 1,
        dependencies: [root],
        bytes: 1,

        valid: async () => true
      }));

      await cache.run("directory", create);
      await mkdir(join(root, "dist"));
      await cache.end();
      await cache.run("directory", create);

      expect(create).toHaveBeenCalledTimes(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("invalidates transitive owners and cycles without evicting unrelated results", async () => {
    const cache = new CompilationCache();

    const create = (owner: string, dependency: string) =>
      vi.fn(async () => ({
        owner,
        dependencies: [dependency],
        value: owner,
        bytes: 1,

        valid: async () => true
      }));

    const token = create("tokens", "theme");
    const theme = create("theme", "tokens");
    const app = create("app", "theme");
    const unrelated = create("unrelated", "other");

    for (const [key, factory] of [
      ["tokens", token],
      ["theme", theme],
      ["app", app],
      ["unrelated", unrelated]
    ] as const)
      await cache.run(key, factory);

    cache.invalidate("tokens");

    for (const [key, factory] of [
      ["tokens", token],
      ["theme", theme],
      ["app", app],
      ["unrelated", unrelated]
    ] as const)
      await cache.run(key, factory);

    expect(token).toHaveBeenCalledTimes(2);
    expect(theme).toHaveBeenCalledTimes(2);
    expect(app).toHaveBeenCalledTimes(2);
    expect(unrelated).toHaveBeenCalledTimes(1);
  });
});
