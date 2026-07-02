import { type TransformOptions, transformFileAsync } from "@babel/core";
import {
  type PluginOptions,
  minchoBabelPlugin,
  minchoStyledComponentPlugin
} from "@mincho-js/babel";

export type BabelOptions = Omit<
  TransformOptions,
  | "ast"
  | "filename"
  | "root"
  | "sourceFileName"
  | "sourceMaps"
  | "inputSourceMap"
> & {
  jsxCssProp?: boolean;
};

export async function babelTransform(path: string, babel: BabelOptions = {}) {
  const { jsxCssProp = false, ...babelCoreOptions } = babel;
  const options: PluginOptions & { jsxCssProp?: boolean } = {
    result: ["", ""],
    jsxCssProp
  };
  const result = await transformFileAsync(path, {
    ...babelCoreOptions,
    plugins: [
      ...(Array.isArray(babelCoreOptions.plugins)
        ? babelCoreOptions.plugins
        : []),
      minchoStyledComponentPlugin(),
      [minchoBabelPlugin(), options]
    ],
    presets: [
      ...(Array.isArray(babelCoreOptions.presets)
        ? babelCoreOptions.presets
        : []),
      "@babel/preset-typescript"
    ],
    sourceMaps: false
  });

  if (result === null || result.code == null) {
    throw new Error(`Failed to transform ${path}`);
  }

  return { result: options.result, code: result.code };
}

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { afterEach, describe, expect, it } = import.meta.vitest;

  let fixtureIndex = 0;
  const fixtureRoots: string[] = [];

  async function createBabelFixture(source: string, label: string) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    fixtureIndex += 1;
    const fixtureRoot = path.join(
      process.env.TMPDIR ?? `${process.cwd()}/temps`,
      `mincho-babel-css-prop-${fixtureIndex}-${label}`
    );
    const fixturePath = path.join(fixtureRoot, `${label}.tsx`);

    fixtureRoots.push(fixtureRoot);
    await fs.mkdir(fixtureRoot, { recursive: true });
    await fs.writeFile(fixturePath, source, "utf8");

    return fixturePath;
  }

  afterEach(async () => {
    const fs = await import("node:fs/promises");

    await Promise.all(
      fixtureRoots
        .splice(0)
        .map((fixtureRoot) =>
          fs.rm(fixtureRoot, { recursive: true, force: true })
        )
    );
  });

  function escapeRegExp(input: string) {
    return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  describe("babelTransform", () => {
    it("extracts css prop generated css calls into sidecar output", async () => {
      const fixturePath = await createBabelFixture(
        `
          function App() {
            return <div className="base" css={{ color: "red" }} />;
          }
        `,
        "css-prop-sidecar"
      );
      const { result, code } = await babelTransform(fixturePath, {
        jsxCssProp: true
      });
      const [sidecarFile, sidecarSource] = result;
      const exportedDeclarations = sidecarSource.match(/export var/g) ?? [];

      expect(sidecarFile).toMatch(/^extracted_[a-z0-9]+\.css\.ts$/);
      expect(sidecarSource).toContain("@mincho-js/css");
      expect(sidecarSource).toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*css\(\{\s*color: "red"\s*\}\);/s
      );
      expect(exportedDeclarations).toHaveLength(1);
      expect(sidecarSource).not.toMatch(
        /export var [A-Za-z_$][\w$]* = [A-Za-z_$][\w$]*cx\(/s
      );
      const sidecarImportMatch = new RegExp(
        `import \\{ ([^}]+) \\} from "${escapeRegExp(sidecarFile)}";`
      ).exec(code);
      const sidecarRuntimeNames = [
        ...((sidecarImportMatch?.[1] ?? "").matchAll(
          /(?:^|, )([A-Za-z_$][\w$]*)(?: as ([A-Za-z_$][\w$]*))?/g
        ) ?? [])
      ].map(([, importedName, localName]) => localName ?? importedName);
      const cxImportMatch =
        /import \{ [^}]*\bcx(?: as ([A-Za-z_$][\w$]*))?[^}]*\} from "@mincho-js\/css";/.exec(
          code
        );
      const cxIdentifier = cxImportMatch?.[1] ?? "cx";
      const classNameMergeMatch =
        /className=\{([A-Za-z_$][\w$]*)\("base", ([A-Za-z_$][\w$]*)\)\}/.exec(
          code
        );

      expect(sidecarImportMatch).not.toBeNull();
      expect(cxImportMatch).not.toBeNull();
      expect(classNameMergeMatch).not.toBeNull();
      expect(classNameMergeMatch?.[1]).toBe(cxIdentifier);
      expect(sidecarRuntimeNames).toContain(classNameMergeMatch?.[2]);
      expect(code).not.toContain(" css=");
      expect(code).not.toContain("css={{");
      expect(code).not.toContain('color: "red"');
    });
  });
}
