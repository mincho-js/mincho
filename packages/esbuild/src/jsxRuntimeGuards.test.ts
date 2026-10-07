import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build, context, type BuildResult } from "esbuild";
import { minchoEsbuildPlugins } from "./plugin.js";
import { buildWithMincho } from "./build.js";

const roots: string[] = [];

async function fixture(source: string) {
  const parent = join(process.cwd(), ".cache");
  await mkdir(parent, { recursive: true });

  const root = await mkdtemp(join(parent, "jsx-runtime-guards-"));
  roots.push(root);
  await writeFile(join(root, "entry.tsx"), source);

  return root;
}

function output(result: BuildResult) {
  return result
    .outputFiles!.filter((file) => file.path.endsWith(".js"))
    .map((file) => file.text)
    .join("\n");
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("esbuild automatic JSX runtime specialization", () => {
  it.each(["esm", "cjs"] as const)(
    "redirects the native automatic %s import after Mincho lowering",
    async (format) => {
      const root = await fixture(
        'export const App = () => <div css={{ color: "red" }} />;'
      );

      const result = await build({
        absWorkingDir: root,
        entryPoints: ["entry.tsx"],
        outdir: "out",
        bundle: true,
        write: false,
        format,
        jsx: "automatic",
        jsxImportSource: "@mincho-js/react",
        external: ["@mincho-js/react/*"],
        plugins: minchoEsbuildPlugins({ cache: false, jsxCssProp: true })
      });

      expect(output(result)).toContain("@mincho-js/react/compiled-jsx-runtime");
      expect(output(result)).not.toContain('"@mincho-js/react/jsx-runtime"');
      expect(
        result.outputFiles!.some((file) => file.path.endsWith(".css"))
      ).toBe(true);
    }
  );

  it("redirects automatic runtime resolution from a CommonJS source module", async () => {
    const root = await fixture("exports.App = () => <div />;");
    await writeFile(join(root, "package.json"), '{ "type": "commonjs" }');

    const result = await build({
      absWorkingDir: root,
      entryPoints: ["entry.tsx"],
      outdir: "out",
      bundle: true,
      write: false,
      format: "cjs",
      jsx: "automatic",
      jsxImportSource: "@mincho-js/react",
      external: ["@mincho-js/react/*"],
      plugins: minchoEsbuildPlugins({ cache: false })
    });

    expect(output(result)).toContain(
      'require("@mincho-js/react/compiled-jsx-runtime")'
    );
    expect(output(result)).not.toContain('"@mincho-js/react/jsx-runtime"');
  });

  it("preserves generation evidence through the transactional build", async () => {
    const root = await fixture(
      'export const App = () => <div css={{ color: "red" }} />;'
    );

    const result = await buildWithMincho({
      absWorkingDir: root,
      entryPoints: ["entry.tsx"],
      outdir: "out",
      write: false,
      jsx: "automatic",
      jsxImportSource: "@mincho-js/react",
      external: ["@mincho-js/react/*"],
      mincho: { cache: false, jsxCssProp: true }
    });

    expect(output(result)).toContain("@mincho-js/react/compiled-jsx-runtime");
  }, 15_000);

  it.each([
    ["export const App = () => <div {...incoming} />;", {}],
    ['export const App = () => <div css="uncompiled" />;', {}],
    ["export const App = () => <div />;", { optimizationMode: "development" }],
    [
      "export const App = () => <div />;",
      { optimize: { jsxRuntimeGuards: false } }
    ],
    [
      'import { jsx } from "@mincho-js/react/jsx-runtime"; export const direct = () => jsx("div", incoming); export const App = () => <div />;',
      {}
    ],
    [
      'const { jsx } = require("@mincho-js/react/jsx-runtime"); export const direct = () => jsx("div", incoming); export const App = () => <div />;',
      {}
    ]
  ] as const)("retains guards for %s", async (source, options) => {
    const root = await fixture(source);
    const result = await build({
      absWorkingDir: root,
      entryPoints: ["entry.tsx"],
      outdir: "out",
      bundle: true,
      write: false,
      format: "esm",
      jsx: "automatic",
      jsxImportSource: "@mincho-js/react",
      external: ["@mincho-js/react/*"],
      plugins: minchoEsbuildPlugins({ cache: false, ...options })
    });

    expect(output(result)).toContain("@mincho-js/react/jsx-runtime");
    expect(output(result)).not.toContain("compiled-jsx-runtime");
  });

  it("rechecks importer evidence on every rebuild and handles jsxDEV", async () => {
    const root = await fixture("export const App = () => <div />;");
    const buildContext = await context({
      absWorkingDir: root,
      entryPoints: ["entry.tsx"],
      outdir: "out",
      bundle: true,
      write: false,
      format: "esm",
      jsx: "automatic",
      jsxDev: true,
      jsxImportSource: "@mincho-js/react",
      external: ["@mincho-js/react/*"],
      plugins: minchoEsbuildPlugins({ cache: false })
    });

    try {
      expect(output(await buildContext.rebuild())).toContain(
        "compiled-jsx-dev-runtime"
      );

      await writeFile(
        join(root, "entry.tsx"),
        'export const App = () => <div css="uncompiled" />;'
      );

      const guarded = output(await buildContext.rebuild());

      expect(guarded).toContain("@mincho-js/react/jsx-dev-runtime");
      expect(guarded).not.toContain("compiled-jsx-dev-runtime");

      await writeFile(
        join(root, "entry.tsx"),
        'export const App = () => <div className="compiled" />;'
      );

      expect(output(await buildContext.rebuild())).toContain(
        "compiled-jsx-dev-runtime"
      );
    } finally {
      await buildContext.dispose();
    }
  });
});
