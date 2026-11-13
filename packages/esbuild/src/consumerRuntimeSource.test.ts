import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type Plugin } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { minchoEsbuildPlugins } from "./plugin.js";
import { buildWithMincho } from "./build.js";

const observations = vi.hoisted(() => ({
  receipts: [] as Array<
    { source?: string; watchFiles: readonly string[] } | undefined
  >
}));

vi.mock("@mincho-js/integration", async (original) => {
  const integration = await original<typeof import("@mincho-js/integration")>();
  return {
    ...integration,
    internalCanSkipMinchoTransform: async () => false,
    async babelTransformSource(
      options: Parameters<typeof integration.babelTransformSource>[0]
    ) {
      if (options.source.includes("probe-consumer-runtime"))
        observations.receipts.push(
          await options.babel?.consumerRuntimeSource?.(
            join(options.filename, "..", "helper.ts")
          )
        );
      if (options.source.includes("probe-native-runtime"))
        observations.receipts.push(
          await options.babel?.consumerRuntimeSource?.(
            join(options.filename, "..", "theme.css.ts")
          )
        );
      return {
        code: options.source.replace("authoring-helper", "completed-helper"),
        result: ["", ""]
      };
    }
  };
});

const roots: string[] = [];
afterEach(async () => {
  observations.receipts.length = 0;
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function buildFixture(
  root: string,
  transaction: boolean,
  previous?: Plugin
) {
  const mincho = { cache: false as const, execution: { workers: 0 as const } };
  const options = {
    absWorkingDir: root,
    entryPoints: ["entry.ts"],
    outdir: "out",
    bundle: true,
    write: false,
    logLevel: "silent" as const
  };
  const plugins = minchoEsbuildPlugins(mincho);
  if (previous) plugins.unshift(previous);
  return transaction
    ? buildWithMincho({
        ...options,
        mincho,
        ...(previous ? { plugins: () => [previous] } : {})
      })
    : build({
        ...options,
        plugins
      });
}

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true]
])(
  "only certifies script output when Mincho owns the host load (transaction: %s, earlier loader: %s)",
  async (transaction, earlierLoader) => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await mkdtemp(
      join(process.cwd(), ".cache/runtime-ownership-")
    );
    roots.push(root);
    await writeFile(
      join(root, "entry.ts"),
      '/*probe-consumer-runtime*/ export { alias } from "./helper";'
    );
    await writeFile(
      join(root, "helper.ts"),
      'export const alias = "authoring-helper";'
    );
    const previous: Plugin = {
      name: "earlier-script-loader",
      setup(build) {
        build.onLoad({ filter: /helper\.ts$/ }, () => ({
          contents: 'export const alias = "earlier-host-helper";',
          loader: "js"
        }));
      }
    };
    const result = await buildFixture(
      root,
      transaction,
      earlierLoader ? previous : undefined
    );

    expect(observations.receipts.length).toBeGreaterThan(0);
    for (const receipt of observations.receipts) {
      expect(receipt?.watchFiles).toContain(join(root, "helper.ts"));
      if (earlierLoader) expect(receipt?.source).toBeUndefined();
      else {
        expect(receipt?.source).toContain("completed-helper");
        expect(receipt?.source).not.toContain("authoring-helper");
      }
    }
    if (earlierLoader) {
      expect(result.outputFiles?.[0]?.text).toContain("earlier-host-helper");
    } else {
      expect(result.outputFiles?.[0]?.text).toContain("completed-helper");
    }
  }
);

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true]
])(
  "only certifies native CSS output when the native handler owns the host load (transaction: %s, earlier loader: %s)",
  async (transaction, earlierLoader) => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await mkdtemp(
      join(process.cwd(), ".cache/runtime-ownership-")
    );
    roots.push(root);
    await writeFile(
      join(root, "entry.ts"),
      '/*probe-native-runtime*/ export { theme } from "./theme.css";'
    );
    await writeFile(
      join(root, "theme.css.ts"),
      'import { style } from "@vanilla-extract/css"; export const theme = style({ color: "red" });'
    );
    const previous: Plugin = {
      name: "earlier-native-css-loader",
      setup(build) {
        build.onLoad({ filter: /theme\.css\.ts$/ }, () => ({
          contents: 'export const theme = "earlier-host-theme";',
          loader: "js"
        }));
      }
    };
    const result = await buildFixture(
      root,
      transaction,
      earlierLoader ? previous : undefined
    );

    expect(observations.receipts.length).toBeGreaterThan(0);
    for (const receipt of observations.receipts) {
      expect(receipt?.watchFiles).toContain(join(root, "theme.css.ts"));
      if (earlierLoader) expect(receipt?.source).toBeUndefined();
      else {
        expect(receipt?.source).toContain("theme");
        expect(receipt?.source).not.toContain("style(");
      }
    }
    if (earlierLoader) {
      expect(
        result.outputFiles?.find((file) => file.path.endsWith(".js"))?.text
      ).toContain("earlier-host-theme");
    } else {
      expect(
        result.outputFiles?.find((file) => file.path.endsWith(".css"))?.text
      ).toContain("color: red");
    }
  }
);
