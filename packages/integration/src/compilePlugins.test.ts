import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compile } from "./compile.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const root = await fs.mkdtemp(join(tmpdir(), "mincho-child-plugins-"));
  roots.push(root);
  await fs.writeFile(join(root, "package.json"), '{"name":"child-fixture"}');
  const dependency = join(root, "dependency.custom");
  await fs.writeFile(
    dependency,
    "This disk source must be replaced by the caller loader."
  );
  return { root, dependency };
}

describe("caller loaders in child compilation", () => {
  it.each(["tsx", undefined] as const)(
    "scopes and transforms caller contents with loader %s",
    async (loader) => {
      const { root, dependency } = await fixture();
      const resolveDir = join(root, "loaded");
      await fs.mkdir(resolveDir);
      await fs.writeFile(
        join(resolveDir, "color.ts"),
        'export const color = "red";'
      );
      const pluginData = { loaded: true };
      const resolved = vi.fn();
      const skipped = vi.fn();
      const contents = `import { styled } from "@mincho-js/react";
      import { color } from "./color.ts";
      export const Box = styled("div", { color });
      ${loader ? 'export const view = <div title="loaded" />;' : ""}`;

      const compiled = await compile({
        filePath: join(root, "entry.tsx"),
        originalPath: join(root, "entry.tsx"),
        contents: 'export { Box } from "./dependency.custom";',
        resolverCache: new Map(),
        externals: ["@mincho-js/react", "@mincho-js/react/runtime"],
        loader: { ".custom": "text" },
        plugins: [
          {
            name: "caller-loader",
            async setup(build) {
              await Promise.resolve();
              build.onLoad(
                { filter: /\.custom$/, namespace: "file" },
                () => undefined
              );
              build.onLoad({ filter: /\.custom$/, namespace: "file" }, () => ({
                contents: loader
                  ? new TextEncoder().encode(contents)
                  : contents,
                ...(loader ? { loader } : {}),
                resolveDir,
                pluginData
              }));
              build.onLoad({ filter: /\.custom$/, namespace: "file" }, skipped);
              build.onResolve({ filter: /^\.\/color\.ts$/ }, (args) => {
                resolved(args.pluginData);
                return undefined;
              });
            }
          }
        ]
      });

      expect(compiled.source).toContain(
        `setFileScope)(${JSON.stringify(relative(process.cwd(), dependency))}`
      );
      expect(compiled.source).toContain("$$styled");
      expect(compiled.source).toContain('var color = "red"');
      expect(compiled.watchFiles).toContain(dependency);
      expect(compiled.watchFiles).toContain(join(resolveDir, "color.ts"));
      expect(resolved).toHaveBeenCalledWith(pluginData);
      expect(skipped).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      namespace: "file",
      loader: "text",
      contents: "raw non-JavaScript contents"
    },
    {
      namespace: "virtual",
      loader: "js",
      contents: 'export default "virtual contents";'
    }
  ] as const)(
    "preserves $namespace contents with the $loader loader",
    async ({ namespace, loader, contents }) => {
      const { root, dependency } = await fixture();
      const compiled = await compile({
        filePath: join(root, "entry.tsx"),
        originalPath: join(root, "entry.tsx"),
        contents: 'export { default } from "./dependency.custom";',
        resolverCache: new Map(),
        plugins: [
          {
            name: "caller-loader",
            setup(build) {
              build.onResolve({ filter: /\.custom$/ }, () => ({
                path: dependency,
                namespace
              }));
              build.onLoad({ filter: /\.custom$/, namespace }, () => ({
                contents,
                loader,
                resolveDir: dirname(dependency)
              }));
            }
          }
        ]
      });
      expect(compiled.source).toContain(
        namespace === "file" ? contents : "virtual contents"
      );
      expect(compiled.source).not.toContain(
        `setFileScope)(${JSON.stringify(relative(process.cwd(), dependency))}`
      );
    }
  );
});

describe("CommonJS dependencies in child compilation", () => {
  function evaluate(source: string) {
    const events: string[] = [];
    const module = { exports: {} as { load?: () => void; value?: string } };
    runInNewContext(source, {
      module,
      exports: module.exports,
      events,
      require(id: string) {
        if (id === "@vanilla-extract/css/fileScope")
          return { setFileScope() {}, endFileScope() {} };
        if (id === "lazy-package") {
          events.push("lazy");
          return {};
        }
        throw new Error(`Unexpected dependency: ${id}`);
      }
    });

    return { events, exports: module.exports };
  }

  it.each(["entry", "dependency"])(
    "keeps optional and lazy requires guarded in the %s",
    async (location) => {
      const { root, dependency } = await fixture();
      const guarded = `
        try { require("missing-optional-package"); } catch {}
        exports.load = () => require("lazy-package");
        if (false) require("unreachable-package");
        class Unused { value = require("lazy-package"); }
        events.push("evaluated");
      `;
      await fs.writeFile(dependency, guarded);
      const compiled = await compile({
        filePath: join(root, "entry.cjs"),
        originalPath: join(root, "entry.cjs"),
        contents:
          location === "entry"
            ? guarded
            : 'module.exports = require("./dependency.custom");',
        cwd: root,
        resolverCache: new Map(),
        loader: { ".custom": "js" },
        externals: ["lazy-package"]
      });
      const result = evaluate(compiled.source);

      expect(result.events).toEqual(["evaluated"]);
      result.exports.load!();
      expect(result.events).toEqual(["evaluated", "lazy"]);
    }
  );

  it.each(["ts", "cts", "custom", "loaded"])(
    "parses %s dependencies with their actual TypeScript loader",
    async (extension) => {
      const { root } = await fixture();
      const dependency = join(root, `assertion.${extension}`);
      const contents =
        '// require is only a comment\nexport const value = <string>"ok";';
      await fs.writeFile(dependency, contents);
      const compiled = await compile({
        filePath: join(root, "entry.tsx"),
        originalPath: join(root, "entry.tsx"),
        contents: `export { value } from "./assertion.${extension}";`,
        cwd: root,
        resolverCache: new Map(),
        loader: { ".custom": "ts" },
        plugins:
          extension === "loaded"
            ? [
                {
                  name: "caller-typescript",
                  setup(build) {
                    build.onLoad({ filter: /\.loaded$/ }, () => ({
                      contents,
                      loader: "ts"
                    }));
                  }
                }
              ]
            : []
      });

      expect(evaluate(compiled.source).exports.value).toBe("ok");
      expect(compiled.watchFiles).toContain(dependency);
    }
  );

  it("does not resolve type-only import-equals dependencies", async () => {
    const { root } = await fixture();
    await fs.writeFile(
      join(root, "types.cts"),
      'import T = require("missing-type-package"); export const value: T = "ok";'
    );
    const compiled = await compile({
      filePath: join(root, "entry.tsx"),
      originalPath: join(root, "entry.tsx"),
      contents: 'export { value } from "./types.cts";',
      cwd: root,
      resolverCache: new Map()
    });

    expect(evaluate(compiled.source).exports.value).toBe("ok");
    expect(compiled.source).not.toContain("missing-type-package");
  });

  it("does not resolve type-only import-equals dependencies alongside JSX", async () => {
    const { root } = await fixture();
    await fs.writeFile(
      join(root, "types.tsx"),
      'import T = require("missing-type-package"); type Value = T.Member; const view = <div />; export const value = "ok";'
    );
    const compiled = await compile({
      filePath: join(root, "entry.tsx"),
      originalPath: join(root, "entry.tsx"),
      contents: 'export { value } from "./types.tsx";',
      cwd: root,
      resolverCache: new Map()
    });

    expect(evaluate(compiled.source).exports.value).toBe("ok");
    expect(compiled.source).not.toContain("missing-type-package");
  });
});
