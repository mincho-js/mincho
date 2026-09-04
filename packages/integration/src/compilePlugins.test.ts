import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
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
