import { afterEach, expect, it } from "vitest";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CompilationCache } from "./compilationCache.js";
import { CompilationDiagnostics } from "./diagnostics.js";
import { babelTransformSource } from "./babel.js";
import type { MinchoCacheOptions } from "./executionOptions.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(options?: MinchoCacheOptions) {
  const root = await mkdtemp(join(tmpdir(), "mincho-persistent-"));
  roots.push(root);

  const filename = join(root, "entry.ts");
  const source =
    'import {css} from "@mincho-js/css"; export const box = css({color: "red"});';

  await writeFile(filename, source);

  const create = () => {
    const cache = new CompilationCache();
    cache.configure(options, join(root, ".cache"), "test");

    return cache;
  };

  return { root, filename, source, create };
}

it.each<MinchoCacheOptions>([{ type: "filesystem" }])(
  "restores real Babel results and revalidates virtual providers with cache %j",
  async (cacheOptions) => {
    const { root, filename, source, create } = await fixture(cacheOptions);
    const diagnostics = new CompilationDiagnostics({ console: true });

    // Other tests create workspace directories; observe only this fixture.
    const transform = (cache: CompilationCache) =>
      diagnostics.run(filename, "test", () =>
        babelTransformSource({
          filename,
          source,
          babel: { cwd: root, compilationCache: cache }
        })
      );

    const first = await transform(create());
    const restarted = await transform(create());

    expect(restarted.result).toEqual(first.result);
    expect(restarted.code).toBe(first.code);
    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .some((event) => event.phase === "disk-cache-hit")
    ).toBe(true);

    let color = "red";
    const options = {
      filename: join(root, "App.tsx"),
      source:
        'import {styles} from "./helper"; export const App = () => <div css={styles} />;',
      babel: {
        cwd: root,
        jsxCssProp: true,
        staticCssEvalSourceProvider: {
          resolve: (_owner: string, request: string) =>
            request === "./helper" ? { id: join(root, "helper.ts") } : null,

          load: () => ({
            source: `export const styles = {color: "${color}"};`
          })
        }
      }
    };

    await babelTransformSource({
      ...options,
      babel: { ...options.babel, compilationCache: create() }
    });
    color = "blue";

    const changed = await babelTransformSource({
      ...options,
      babel: { ...options.babel, compilationCache: create() }
    });

    expect(changed.result[1]).toContain('color: "blue"');
  }
);

it.each<MinchoCacheOptions | undefined>([
  undefined,
  true,
  false,
  { type: "memory" }
])(
  "does not persist results when filesystem caching is disabled with %j",
  async (options) => {
    const { root, filename, source, create } = await fixture(options);
    const diagnostics = new CompilationDiagnostics({ console: true });

    const transform = (cache: CompilationCache) =>
      diagnostics.run(filename, "test", () =>
        babelTransformSource({
          filename,
          source,
          babel: { compilationCache: cache }
        })
      );

    const first = await transform(create());
    const restarted = await transform(create());

    expect(restarted.result).toEqual(first.result);
    expect(await readdir(root)).toEqual(["entry.ts"]);
    expect(
      diagnostics
        .snapshot()
        .builds.flatMap((build) => build.events)
        .some((event) => event.phase === "disk-cache-hit")
    ).toBe(false);
  }
);

it("does not publish a failed build or inputs changed after compilation", async () => {
  const { root, filename, source, create } = await fixture({
    type: "filesystem"
  });
  const failed = create();
  failed.begin();
  await babelTransformSource({
    filename,
    source,
    babel: { compilationCache: failed }
  });
  await failed.end(false);

  expect(await readdir(join(root, ".cache"))).toEqual([]);

  const changed = create();
  changed.begin();
  await babelTransformSource({
    filename,
    source,
    babel: { compilationCache: changed }
  });
  await writeFile(filename, source.replace("red", "blue"));

  await expect(changed.end()).rejects.toThrow("inputs changed");
  expect(await readdir(join(root, ".cache"))).toEqual([]);
});

it("invalidates content changes even when mtime is preserved", async () => {
  const { root, create } = await fixture({ type: "filesystem" });
  const file = join(root, "token.txt");
  await writeFile(file, "red");

  const stamp = new Date(1_000_000);
  await utimes(file, stamp, stamp);

  let calls = 0;

  const run = (cache: CompilationCache) =>
    cache.withInputs(() =>
      cache.run("token", async () => {
        calls++;

        const value = await readFile(file, "utf8");
        const fingerprints = await cache.fingerprint([file]);

        return {
          value,
          bytes: 10,
          dependencies: [file],
          manifest: { fingerprints: [...fingerprints] },

          valid: () => cache.unchanged(fingerprints)
        };
      })
    );

  expect(await run(create())).toBe("red");
  expect(await run(create())).toBe("red");
  expect(calls).toBe(1);

  await writeFile(file, "tan");
  await utimes(file, stamp, stamp);

  expect(await run(create())).toBe("tan");
  expect(calls).toBe(2);
});
