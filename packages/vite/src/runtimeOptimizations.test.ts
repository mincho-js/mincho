import { afterEach, describe, expect, it } from "vitest";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { build, createServer } from "vite";
import { minchoVitePlugin } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe("static recipe bundles", () => {
  it("uses current serialized classes in dev after a dependency edit", async () => {
    const cache = join(process.cwd(), ".cache");
    await mkdir(cache, { recursive: true });

    const root = await mkdtemp(join(cache, "static-recipes-dev-"));
    roots.push(root);

    const producer = (variant: string) =>
      `import { rules } from "@mincho-js/css"; export const button = rules({ variants: { size: { large: { padding: 8 }, small: { padding: 4 } } }, defaultVariants: { size: "${variant}" } });`;

    const owner = join(root, "entry.ts");
    const dependency = join(root, "styles.ts");
    await writeFile(
      owner,
      'import { button } from "./styles"; export const className = button();'
    );
    await writeFile(dependency, producer("large"));

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [minchoVitePlugin()],
      server: { middlewareMode: true, watch: null },
      optimizeDeps: { noDiscovery: true }
    });

    try {
      const first = await server.transformRequest("/entry.ts");

      expect(first?.code).not.toContain("button()");
      expect(first?.code).toMatch(/className = "/);

      await writeFile(dependency, producer("small"));
      server.moduleGraph.invalidateAll();

      const second = await server.transformRequest("/entry.ts");

      expect(second?.code).not.toContain("button()");
      expect(second?.code).not.toBe(first?.code);
    } finally {
      await server.close();
    }
  });

  it.each(["serve", "build"] as const)(
    "folds circular recipe reexports with query IDs during %s",
    async (command) => {
      const cache = join(process.cwd(), ".cache");
      await mkdir(cache, { recursive: true });

      const root = await mkdtemp(join(cache, "static-recipes-cycle-"));
      roots.push(root);
      await writeFile(
        join(root, "entry.ts"),
        'import { button } from "./barrel"; export const className = button(); export { button } from "./styles";'
      );
      await writeFile(
        join(root, "barrel.ts"),
        'export { button } from "./entry.ts?used";'
      );
      await writeFile(
        join(root, "styles.ts"),
        'import { rules } from "@mincho-js/css"; export const button = rules({ base: { color: "red" } });'
      );

      const config = {
        root,
        configFile: false as const,
        logLevel: "silent" as const,
        plugins: [minchoVitePlugin({ optimize: { staticRecipes: true } })]
      };

      if (command === "serve") {
        const server = await createServer({
          ...config,
          server: { middlewareMode: true, watch: null },
          optimizeDeps: { noDiscovery: true }
        });

        try {
          const result = await server.transformRequest("/entry.ts?used");

          expect(result?.code).not.toContain("button()");
          expect(result?.code).toMatch(/className = "/);
        } finally {
          await server.close();
        }
      } else {
        const result = await build({
          ...config,
          build: {
            write: false,
            cssCodeSplit: true,
            minify: false,
            lib: { entry: join(root, "entry.ts?used"), formats: ["es"] }
          }
        });
        if ("on" in result) throw new Error("Unexpected watcher");

        const outputs = (Array.isArray(result) ? result : [result]).flatMap(
          (item) => item.output
        );
        const chunks = outputs.filter((item) => item.type === "chunk");

        expect(chunks).toHaveLength(1);
        expect(chunks[0]?.code).not.toContain("button()");
        expect(chunks[0]?.code).toMatch(/className = "/);
        expect(
          outputs.some(
            (item) =>
              item.type === "asset" && String(item.source).includes("red")
          )
        ).toBe(true);
      }
    }
  );

  it.each(["recipe", "styled"])(
    "folds %s reexports while retaining identical CSS",
    async (kind) => {
      const cache = join(process.cwd(), ".cache");
      await mkdir(cache, { recursive: true });

      const root = await mkdtemp(join(cache, "static-recipes-"));
      roots.push(root);
      await writeFile(
        join(root, "entry.tsx"),
        kind === "recipe"
          ? 'import { button } from "./barrel"; export const className = button({ size: "large" });'
          : 'import { button as Button } from "./barrel"; export const App = () => <Button size="large" className="extra" id="cta">Buy</Button>;'
      );
      await writeFile(
        join(root, "barrel.ts"),
        'export { button } from "./styles";'
      );
      await writeFile(
        join(root, "styles.ts"),
        `${kind === "recipe" ? 'import { rules } from "@mincho-js/css"; export const button = rules' : 'import { styled } from "@mincho-js/react"; export const button = styled.button'}({ base: { color: "red" }, variants: { size: { large: { padding: 8 }, small: { padding: 4 } } } });`
      );

      const run = async (enabled: boolean) => {
        const result = await build({
          root,
          configFile: false,
          logLevel: "silent",
          plugins: [
            minchoVitePlugin({
              optimize: { staticRecipes: enabled, styledComponents: enabled }
            })
          ],
          esbuild: { jsx: "automatic" },
          build: {
            write: false,
            cssCodeSplit: true,
            minify: true,
            cssMinify: true,
            lib: { entry: join(root, "entry.tsx"), formats: ["es"] },
            rollupOptions: {
              external: (id) =>
                id.startsWith("@mincho-js/react") || id.startsWith("react")
            }
          }
        });
        if ("on" in result) throw new Error("Unexpected watcher");

        const outputs = (Array.isArray(result) ? result : [result]).flatMap(
          (item) => item.output
        );

        return {
          js: outputs
            .filter((item) => item.type === "chunk")
            .map((item) => item.code)
            .join("\n"),
          css: outputs
            .filter(
              (item) => item.type === "asset" && item.fileName.endsWith(".css")
            )
            .map((item) => (item.type === "asset" ? String(item.source) : ""))
            .join("\n")
        };
      };

      const baseline = await run(false);
      const optimized = await run(true);

      expect(optimized.css).toBe(baseline.css);
      expect(optimized.css).toContain("padding:8px");
      expect(optimized.js).not.toMatch(/defaultVariants|compoundVariants/);

      if (kind === "styled") {
        expect(optimized.js).not.toContain("$$styled");
        expect(optimized.js).toContain('"button"');
      }

      expect(optimized.js.length).toBeLessThan(baseline.js.length);
    }
  );
});
