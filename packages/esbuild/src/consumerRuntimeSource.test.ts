import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, type BuildOptions, type Plugin } from "esbuild";
import { afterEach, expect, it, vi } from "vitest";
import { minchoEsbuildPlugins } from "./plugin.js";
import { buildWithMincho } from "./build.js";

const ownerObservations = vi.hoisted(() => ({
  views: [] as (string | undefined)[],
  statuses: [] as string[],
  badHash: false,
  enabled: false
}));

const observations = vi.hoisted(() => ({
  receipts: [] as Array<
    | {
        source?: string;
        watchFiles: readonly string[];
        intrinsicEffects?: {
          kind: string;
          loader: string;
          sourceHash: string;
          version: string;
        };
      }
    | undefined
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
      if (ownerObservations.enabled) {
        const view = await options.babel?.consumerRuntimeSource?.(
          options.filename,
          {
            purpose: "intrinsic-owner",
            sourceHash: ownerObservations.badHash
              ? "incorrect"
              : createHash("sha256").update(options.source).digest("hex")
          }
        );
        ownerObservations.views.push(view?.source);
        ownerObservations.statuses.push(
          view === undefined
            ? "unsupported"
            : view.source === undefined
              ? "unavailable"
              : "source"
        );
        return {
          code: options.source.includes("remove-final-jsx")
            ? "export const View=()=> null"
            : options.source,
          result: ["", ""]
        };
      }
      if (options.source.includes("probe-consumer-runtime"))
        observations.receipts.push(
          await options.babel?.consumerRuntimeSource?.(
            join(
              options.filename,
              "..",
              options.source.match(/probe-consumer-runtime:([^*]+)/)?.[1] ??
                "helper.ts"
            )
          )
        );
      if (options.source.includes("probe-native-runtime"))
        observations.receipts.push(
          await options.babel?.consumerRuntimeSource?.(
            join(options.filename, "..", "theme.css.ts")
          )
        );
      if (options.source.includes("probe-native-asset")) {
        const specifier =
          options.source.match(/probe-native-asset:([^*]+)/)?.[1] ??
          "./plain.css";
        const resolved =
          await options.babel?.staticCssEvalSourceProvider?.resolve(
            options.filename,
            specifier
          );
        const id = resolved?.id ?? join(options.filename, "..", "plain.css");
        observations.receipts.push(
          await options.babel?.consumerRuntimeSource?.(
            id,
            options.source.includes("one-arg-request")
              ? undefined
              : {
                  purpose: "intrinsic-effects",
                  importerId: options.filename,
                  specifier,
                  resolutionMode: "import",
                  attributes: "none"
                }
          )
        );
      }
      return {
        code: options.source.replace("authoring-helper", "completed-helper"),
        result: ["", ""]
      };
    }
  };
});

const roots: string[] = [];
afterEach(async () => {
  ownerObservations.enabled = false;
  ownerObservations.views.length = 0;
  ownerObservations.statuses.length = 0;
  ownerObservations.badHash = false;
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

it.each(
  [false, true].flatMap((transaction) =>
    [false, true].map((earlierLoader) => [transaction, earlierLoader] as const)
  )
)(
  "observes CSS-suffixed scripts through their actual script loader (transaction: %s, earlier loader: %s)",
  async (transaction, earlierLoader) => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await mkdtemp(
      join(process.cwd(), ".cache/runtime-ownership-")
    );
    roots.push(root);
    await writeFile(
      join(root, "entry.ts"),
      '/*probe-consumer-runtime:helper.css.js*/ export { alias } from "./helper.css.js";'
    );
    await writeFile(
      join(root, "helper.css.js"),
      'export const alias = "authoring-helper";'
    );
    const previous: Plugin = {
      name: "earlier-script-loader",
      setup(build) {
        build.onLoad({ filter: /helper\.css\.js$/ }, () => ({
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
      expect(receipt?.watchFiles).toContain(join(root, "helper.css.js"));
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

const assetCases: Array<{
  name: string;
  expected: boolean;
  loader?: "css" | "local-css" | "js";
  before?: boolean;
  after?: boolean;
  pluginData?: boolean;
  suffix?: boolean;
  longer?: boolean;
  namespace?: boolean;
  oneArg?: boolean;
  transaction?: boolean;
}> = [
  { name: "native CSS", expected: true },
  { name: "transaction native CSS", transaction: true, expected: true },
  {
    name: "transaction resolver pluginData",
    transaction: true,
    pluginData: true,
    expected: false
  },
  { name: "one-argument lookup", oneArg: true, expected: false },
  { name: "query suffix", suffix: true, expected: false },
  { name: "longest loader override", longer: true, expected: false },
  { name: "opaque namespace", namespace: true, expected: false },
  { name: "local CSS loader", loader: "local-css" as const, expected: true },
  { name: "JS override", loader: "js" as const, expected: false },
  { name: "opaque earlier", before: true, expected: false },
  { name: "opaque later", after: true, expected: false },
  { name: "resolver pluginData", pluginData: true, expected: false }
];
it.each(assetCases)(
  "only grants native CSS effects with complete loader evidence: $name",
  async (fixture) => {
    await mkdir(join(process.cwd(), ".cache"), { recursive: true });
    const root = await mkdtemp(join(process.cwd(), ".cache/native-effects-"));
    roots.push(root);
    const filename = fixture.longer ? "plain.special.css" : "plain.css";
    const specifier = `./${filename}${fixture.suffix ? "?raw" : ""}`;
    await writeFile(
      join(root, "entry.ts"),
      `/*probe-native-asset:${specifier}*/ ${fixture.oneArg ? "/*one-arg-request*/" : ""} import ${JSON.stringify(specifier)}; export const ok=true;`
    );
    await writeFile(
      join(root, filename),
      fixture.loader === "js" || fixture.longer
        ? "globalThis.__assetJs=true;"
        : ".plain{color:red}"
    );
    const opaque: Plugin = {
      name: "opaque-css-loader",
      setup(build) {
        build.onLoad({ filter: /plain\.css$/ }, () => ({
          contents: "globalThis.__assetJs=true;",
          loader: "js"
        }));
      }
    };
    const data: Plugin = {
      name: "resolution-data",
      setup(build) {
        build.onResolve({ filter: /plain\.css$/ }, () => ({
          path: join(root, "plain.css"),
          pluginData: { unknown: true }
        }));
      }
    };
    const namespace: Plugin = {
      name: "opaque-namespace",
      setup(build) {
        build.onResolve({ filter: /plain\.css$/ }, () => ({
          path: join(root, "plain.css"),
          namespace: "opaque"
        }));
        build.onLoad({ filter: /.*/, namespace: "opaque" }, () => ({
          contents: "export const opaque=true;",
          loader: "js"
        }));
      }
    };
    const plugins = minchoEsbuildPlugins({
      cache: false,
      execution: { workers: 0 }
    });
    if (fixture.before) plugins.unshift(opaque);
    if (fixture.after) plugins.push(opaque);
    if (fixture.pluginData) plugins.unshift(data);
    if (fixture.namespace) plugins.unshift(namespace);
    const buildOptions: BuildOptions = {
      absWorkingDir: root,
      entryPoints: ["entry.ts"],
      outdir: "out",
      write: false,
      bundle: true,
      logLevel: "silent" as const,
      ...(fixture.longer
        ? { loader: { ".css": "css" as const, ".special.css": "js" as const } }
        : fixture.loader
          ? { loader: { ".css": fixture.loader } }
          : {})
    };
    const output = fixture.transaction
      ? await buildWithMincho({
          ...buildOptions,
          mincho: { cache: false, execution: { workers: 0 } },
          plugins: () => (fixture.pluginData ? [data] : [])
        })
      : await build({ ...buildOptions, plugins });
    expect(observations.receipts.length).toBeGreaterThan(0);
    for (const receipt of observations.receipts) {
      if (receipt) expect(receipt.watchFiles).toContain(join(root, filename));
      if (fixture.expected) {
        expect(receipt?.source).toBeUndefined();
        expect(receipt?.intrinsicEffects?.kind).toBe("native-css");
        expect(receipt?.intrinsicEffects?.sourceHash).toMatch(/^[a-f0-9]{64}$/);
        expect(
          output.outputFiles?.some((file) => file.path.endsWith(".css"))
        ).toBe(true);
      } else expect(receipt?.intrinsicEffects).toBeUndefined();
    }
  }
);

async function ownerFixture(
  source: string,
  options: BuildOptions = {},
  config?: object
) {
  ownerObservations.enabled = true;
  const cache = join(process.cwd(), ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "native-owner-"));
  roots.push(root);
  await writeFile(join(root, "entry.tsx"), source);
  if (config)
    await writeFile(join(root, "tsconfig.json"), JSON.stringify(config));
  await build({
    absWorkingDir: root,
    entryPoints: ["entry.tsx"],
    bundle: false,
    write: false,
    logLevel: "silent",
    jsx: "automatic",
    jsxImportSource: "selected-runtime",
    plugins: minchoEsbuildPlugins({
      jsxCssProp: true,
      cache: false,
      execution: { workers: 0 }
    }),
    ...options
  });
}
it("observes native automatic runtime from exact captured owner bytes", async () => {
  await ownerFixture("export const View=()=> <div/>;");
  expect(ownerObservations.views[0]).toContain(
    '"selected-runtime/jsx-runtime"'
  );
});
it("native owner view preserves source JSX pragma selection", async () => {
  await ownerFixture(
    "/** @jsxImportSource pragma-runtime */\nexport const View=()=> <div/>;"
  );
  expect(ownerObservations.views[0]).toContain('"pragma-runtime/jsx-runtime"');
});
it("uses native nearest tsconfig discovery without claiming a config snapshot", async () => {
  await ownerFixture(
    "export const View=()=> <div/>;",
    {},
    {
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "configured-runtime"
      }
    }
  );
  expect(ownerObservations.views[0]).toContain(
    '"configured-runtime/jsx-runtime"'
  );
});
it("does not synthesize a runtime import when native owner has no JSX", async () => {
  await ownerFixture("export const View=()=> null;");
  expect(ownerObservations.views[0]).not.toContain("jsx-runtime");
});
it("declines a mismatched exact owner hash", async () => {
  ownerObservations.badHash = true;
  await ownerFixture("export const View=()=> <div/>;");
  expect(ownerObservations.views[0]).toBeUndefined();
  expect(ownerObservations.statuses[0]).toBe("unavailable");
});
it("does not claim the source after an opaque preceding handler", async () => {
  await ownerFixture("export const View=()=> <div/>;", {
    plugins: [
      {
        name: "earlier",
        setup(b) {
          b.onLoad({ filter: /never-match/ }, () => undefined);
        }
      },
      ...minchoEsbuildPlugins({
        jsxCssProp: true,
        cache: false,
        execution: { workers: 0 }
      })
    ]
  });
  expect(ownerObservations.views[0]).toBeUndefined();
  expect(ownerObservations.statuses[0]).toBe("unsupported");
});

it("keeps the original observation when later Babel output removes JSX", async () => {
  await ownerFixture("/* remove-final-jsx */ export const View=()=> <div/>;");
  // This may conservatively observe an extra runtime. It is not final-output
  // equivalence and must never authorize purity or export evaluation.
  expect(ownerObservations.views[0]).toContain(
    '"selected-runtime/jsx-runtime"'
  );
});
it("declines injected execution roots outside the native observation contract", async () => {
  const cache = join(process.cwd(), ".cache");
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, "native-owner-inject-"));
  roots.push(root);
  const injection = join(root, "injected.js");
  await writeFile(injection, "export const injected = 1");
  await ownerFixture("export const View=()=> <div/>;", { inject: [injection] });
  expect(ownerObservations.views[0]).toBeUndefined();
  expect(ownerObservations.statuses[0]).toBe("unsupported");
});
