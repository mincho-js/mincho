import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { build, type Plugin, type Rollup } from "vite";
import { minchoVitePlugin } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function fixture(css: string) {
  const cache = join(process.cwd(), ".cache");
  await mkdir(cache, { recursive: true });

  const root = await mkdtemp(join(cache, "css-watch-"));
  roots.push(root);
  await Promise.all([
    writeFile(
      join(root, "package.json"),
      '{"name":"css-watch-fixture","type":"module"}'
    ),
    writeFile(
      join(root, "entry.js"),
      'import "./style.css";export const value = 1;'
    ),
    writeFile(join(root, "style.css"), css)
  ]);

  return root;
}

function options(root: string) {
  return {
    root,
    configFile: false as const,
    logLevel: "silent" as const,
    build: {
      write: false,
      minify: false as const,
      cssMinify: false as const,
      cssCodeSplit: true,
      lib: { entry: join(root, "entry.js"), formats: ["es" as const] },
      rollupOptions: {
        output: {
          entryFileNames: "[name]-[hash].js",
          assetFileNames: "[name]-[hash][extname]"
        }
      }
    }
  };
}

it("retains cached entry CSS contracts during watch, updates CSS and removes stale links", async () => {
  const root = await fixture(".example { color: red; }");
  const outputs: Array<{ css: string; cssFiles: string[]; js: string }> = [];
  const transformed = new Map<string, number>();
  let failure: Error | undefined;
  let watcherClosed = false;
  let completedOutputCount = 0;
  let closingResults = Promise.resolve();
  const watchEvents: string[] = [];
  let wake: (() => void) | undefined;
  const capture: Plugin = {
    name: "capture-watch-output",
    enforce: "post",

    transform(_code, id) {
      transformed.set(id, (transformed.get(id) ?? 0) + 1);
    },

    closeWatcher() {
      watcherClosed = true;
    },

    generateBundle: {
      order: "post",

      handler(_options, bundle) {
        const assets = Object.values(bundle).filter(
          (item) => item.type === "asset" && item.fileName.endsWith(".css")
        );

        const chunks = Object.values(bundle).filter(
          (item) => item.type === "chunk"
        );

        outputs.push({
          css: assets
            .map((item) => (item.type === "asset" ? String(item.source) : ""))
            .join("\n"),
          cssFiles: assets.map((item) => item.fileName),
          js: chunks
            .map((item) => (item.type === "chunk" ? item.code : ""))
            .join("\n")
        });
      }
    }
  };

  const result = await build({
    ...options(root),
    plugins: [minchoVitePlugin(), capture],
    build: {
      ...options(root).build,

      // Polling observes size/mtime changes even when the OS coalesces rapid
      // writes to the same CSS file. Synchronization still uses native END.
      watch: { buildDelay: 20, chokidar: { usePolling: true, interval: 100 } }
    }
  });
  if (!("on" in result)) throw new Error("expected native watcher");

  const watcher: Rollup.RollupWatcher = result;
  watcher.on("change", (id, event) => {
    watchEvents.push(`${event.event}:${id}`);
  });
  watcher.on("event", (event) => {
    watchEvents.push(`${event.code}:outputs=${outputs.length}`);

    if (event.code === "ERROR") {
      failure = new Error(event.error.message, { cause: event.error });
      wake?.();
    }

    if (event.code === "BUNDLE_END") {
      closingResults = Promise.all([closingResults, event.result.close()])
        .then(() => undefined)
        .catch((error: unknown) => {
          failure = error instanceof Error ? error : new Error(String(error));
          wake?.();
        });
    }

    if (event.code === "END") {
      // generateBundle runs before Rollup finishes installing this generation's
      // watchers. Only mutate inputs after END and the BUNDLE_END result closes.
      const endedOutputCount = outputs.length;
      void closingResults.then(() => {
        completedOutputCount = Math.max(completedOutputCount, endedOutputCount);
        wake?.();
      });
    }
  });

  const waitForOutput = async (count: number) => {
    if (failure) throw failure;
    if (completedOutputCount >= count) return outputs[count - 1]!;

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        wake = undefined;
        reject(
          new Error(
            `Timed out waiting for watch build ${count}: ${watchEvents.join(", ")}`
          )
        );
      }, 10_000);

      wake = () => {
        if (!failure && completedOutputCount < count) return;

        clearTimeout(timeout);
        wake = undefined;

        if (failure) reject(failure);
        else resolve();
      };
    });

    return outputs[count - 1]!;
  };

  try {
    const first = await waitForOutput(1);

    expect(first.css).toContain("red");
    expect(first.cssFiles).toHaveLength(1);
    expect(first.js).toContain(first.cssFiles[0]);

    const initialEntryTransforms = transformed.get(join(root, "entry.js"));
    await writeFile(
      join(root, "style.css"),
      ".example { color: blue; padding: 4px; }"
    );

    const second = await waitForOutput(2);

    expect(transformed.get(join(root, "entry.js"))).toBe(
      initialEntryTransforms
    );
    expect(second.css).toContain("blue");
    expect(second.css).not.toContain("red");
    expect(second.cssFiles).not.toEqual(first.cssFiles);
    expect(second.js).toContain(second.cssFiles[0]);
    expect(second.js).not.toContain(first.cssFiles[0]);

    await writeFile(join(root, "style.css"), "");

    const empty = await waitForOutput(3);

    expect(empty.css).toBe("");
    expect(empty.cssFiles).toHaveLength(1);
    expect(empty.js).toContain(empty.cssFiles[0]);
    expect(empty.js).not.toContain(second.cssFiles[0]);
    expect(transformed.get(join(root, "entry.js"))).toBe(
      initialEntryTransforms
    );

    await writeFile(join(root, "entry.js"), "export const value = 2;");

    const third = await waitForOutput(4);

    expect(third.cssFiles).toEqual([]);
    expect(third.js).not.toContain(".css");
  } finally {
    wake = undefined;

    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        watcher.close(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("Timed out closing native Vite watcher")),
            5_000
          );
        })
      ]);

      expect(watcherClosed).toBe(true);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}, 30_000);

it("retains native Vite's empty CSS asset and accepts its import", async () => {
  const root = await fixture("");
  const native = await build(options(root));
  const linked = await build({
    ...options(root),
    plugins: [minchoVitePlugin()]
  });
  if ("on" in native || "on" in linked) throw new Error("unexpected watcher");

  const css = (result: Exclude<typeof native, Rollup.RollupWatcher>) =>
    (Array.isArray(result) ? result[0]! : result).output.filter(
      (item) => item.type === "asset" && item.fileName.endsWith(".css")
    );

  expect(css(linked)).toEqual(css(native));
  expect(css(native)).toHaveLength(1);
  expect(css(native)[0]).toMatchObject({ source: "" });
}, 20_000);
