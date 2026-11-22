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
import { CompilationInputs, fingerprintFiles } from "./compilationInputs.js";
import { CompilationIoPool } from "./ioPool.js";

describe("compilation input sessions", () => {
  it("preserves directory read errors while retaining configuration fingerprints", async () => {
    const root = await mkdtemp(join(tmpdir(), "mincho-input-directory-"));
    const file = join(root, "package.json");
    const inputs = new CompilationInputs();
    try {
      await mkdir(file);
      const originalError = await inputs
        .readOptionalFile(file)
        .catch((error) => error);
      expect(originalError).toMatchObject({ code: "EISDIR" });
      expect((await inputs.fingerprint([file])).get(file)).toMatch(
        /^directory:/
      );
      await rm(file, { recursive: true });
      await writeFile(file, '{"name":"new"}');
      await expect(inputs.readOptionalFile(file)).rejects.toBe(originalError);
      expect(await inputs.validate()).toEqual({
        files: [file],
        directories: []
      });
      const fresh = new CompilationInputs();
      expect(
        Buffer.from((await fresh.readOptionalFile(file))!).toString()
      ).toContain("new");
      expect(
        await fresh.readOptionalFile(join(root, "missing"))
      ).toBeUndefined();
      expect(await fresh.readOptionalFile(join(file, "child"))).toBeUndefined();
      fresh.close();
    } finally {
      inputs.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["file", "missing"])(
    "rejects a directory changing to %s between read and fingerprint",
    async (next) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-input-type-change-"));
      const file = join(root, "package.json");
      const inputs = new CompilationInputs(async (path) => {
        try {
          return await readFile(path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
          await rm(path, { recursive: true });
          if (next === "file") await writeFile(path, '{"name":"new"}');
          throw error;
        }
      });
      try {
        await mkdir(file);
        await expect(inputs.readOptionalFile(file)).rejects.toThrow(
          "Mincho inputs changed during compilation"
        );
      } finally {
        inputs.close();
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each([
    "fingerprint",
    "unchanged",
    "hasExternalBabelConfiguration"
  ] as const)(
    "uses the configured I/O limit for %s outside an input session",
    async (operation) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-inputs-"));

      try {
        const files = [join(root, "package.json"), join(root, "tokens.ts")];
        await writeFile(files[0]!, '{"babel":{}}');
        await writeFile(files[1]!, 'export const color = "red";');
        const fingerprints = await fingerprintFiles(files);
        let active = 0;
        let peak = 0;
        class ObservedIoPool extends CompilationIoPool {
          override run<T>(read: () => Promise<T>): Promise<T> {
            return super.run(async () => {
              active++;
              peak = Math.max(peak, active);

              try {
                await new Promise<void>((resolve) => setImmediate(resolve));

                return await read();
              } finally {
                active--;
              }
            });
          }
        }
        const cache = new CompilationCache();
        cache.configure(
          { type: "memory" },
          root,
          "test",
          new ObservedIoPool(1)
        );

        if (operation === "fingerprint")
          expect(await cache.fingerprint(files)).toEqual(fingerprints);
        else if (operation === "unchanged")
          expect(await cache.unchanged(fingerprints)).toBe(true);
        else
          expect(await cache.hasExternalBabelConfiguration(fingerprints)).toBe(
            true
          );

        expect(peak).toBe(1);
        expect(active).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

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

  it.each([false, true])(
    "recomputes a standalone pending result after invalidation (value validator: %s)",
    async (withValidator) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-review11-generation-"));
      try {
        const manifest = join(root, "package.json");
        await writeFile(manifest, '{"name":"old"}');
        const cache = new CompilationCache();
        let entered!: () => void;
        let release!: () => void;
        const enteredPromise = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const releasePromise = new Promise<void>((resolve) => {
          release = resolve;
        });
        const create = vi.fn(async () => {
          const buffer = (await cache.readOptionalFile(manifest))!;
          const value = JSON.parse(Buffer.from(buffer).toString()).name;
          entered();
          await releasePromise;
          return {
            value,
            bytes: 1,
            dependencies: [manifest],
            valid: async () => true
          };
        });
        const validate = withValidator ? async () => true : undefined;
        const producer = cache.withInputs(() =>
          cache.run("keys", create, validate)
        );
        const producerResult = producer.catch((error: Error) => error.message);
        await enteredPromise;
        const waiter = cache.withInputs(() =>
          cache.run("keys", create, validate)
        );
        await writeFile(manifest, '{"name":"new"}');
        cache.invalidate(manifest);
        release();
        expect(await producerResult).toContain(
          "Mincho inputs changed during compilation"
        );
        expect(await waiter).toBe("new");
        expect(create).toHaveBeenCalledTimes(2);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

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
