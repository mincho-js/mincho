import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { internalMinchoProjectEngine } from "@mincho-js/integration";
import { createServer } from "vite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { minchoVitePlugin } from "./index.js";

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("Vite runtime optimization dependencies", () => {
  it("merges producer dependencies into the extraction record and invalidates the owner", async () => {
    const root = await mkdtemp(path.resolve(".test-runtime-dependencies-"));
    directories.push(root);
    const owner = path.join(root, "entry.ts");
    const producer = path.join(root, "styles.ts");
    const tokens = path.join(root, "tokens.ts");
    const source = (variant: "large" | "small") => `
      import { rules } from "@mincho-js/css";
      export const button = rules({
        variants: { size: { large: { padding: 8 }, small: { padding: 4 } } },
        defaultVariants: { size: "${variant}" }
      });
    `;
    await writeFile(producer, source("large"));
    await writeFile(tokens, 'export const tokens = { color: "red" };');
    await writeFile(
      owner,
      `import { css } from "@mincho-js/css";
       import { button } from "./styles";
       import { tokens } from "./tokens";
       export const ownClass = css(tokens);
       export const className = button();`
    );

    const states: NonNullable<
      ReturnType<internalMinchoProjectEngine["getFileResult"]>
    >[] = [];
    let getFileResult: internalMinchoProjectEngine["getFileResult"] = () =>
      undefined;
    const refresh = internalMinchoProjectEngine.prototype.refreshFile;
    vi.spyOn(
      internalMinchoProjectEngine.prototype,
      "refreshFile"
    ).mockImplementation(function (this: internalMinchoProjectEngine, input) {
      const result = refresh.call(this, input);

      if (input.fileId === owner) {
        getFileResult = this.getFileResult.bind(this);
        states.push(this.getFileResult(owner)!);
      }

      return result;
    });

    const server = await createServer({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [
        minchoVitePlugin({
          babel: { optimize: { staticRecipes: true } }
        })
      ],
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null }
    });

    try {
      const first = await server.transformRequest("/entry.ts");
      expect(first?.code).not.toContain("button()");
      const extracted = states.find((state) => state.generatedArtifacts.length);
      expect(extracted).toBeDefined();
      expect(extracted?.dependencyFiles).not.toContain(producer);
      const merged = getFileResult(owner);
      expect(merged?.dependencyFiles).toEqual(
        expect.arrayContaining([producer, tokens])
      );
      expect(
        merged?.dependencyFiles.filter((file) => file === producer)
      ).toHaveLength(1);
      expect(merged).toMatchObject({
        generatedArtifacts: extracted!.generatedArtifacts,
        providerSnapshot: extracted!.providerSnapshot
      });
      expect(merged?.sourceHash).toBe(extracted!.sourceHash);
      expect(merged?.sourceVersion).toBe(extracted!.sourceVersion);

      await writeFile(producer, source("small"));
      server.watcher.emit("change", producer);
      await vi.waitFor(() => {
        expect(getFileResult(owner)?.invalidated).toBe(true);
        expect(
          server.moduleGraph.getModuleById(owner)?.transformResult
        ).toBeNull();
      });
      const second = await server.transformRequest("/entry.ts");
      expect(second?.code).not.toContain("button()");
      expect(second?.code).not.toBe(first?.code);
    } finally {
      await server.close();
    }
  }, 20000);
});
