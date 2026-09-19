import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InternalSourceAstCache } from "@mincho-js/babel";
import { canSkipMinchoTransform } from "./transformEligibility.js";
import { CompilationCache } from "./compilationCache.js";
import { babelTransformSource } from "./babel.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

const babel = { babelrc: false, configFile: false } as const;

describe("adapter transform eligibility", () => {
  it("skips ordinary TS without changing the direct Babel API", async () => {
    const options = {
      filename: "/plain.ts",
      source: "export const size: number = 2;",
      babel
    };

    expect(await canSkipMinchoTransform(options)).toBe(true);
    expect((await babelTransformSource(options)).code).not.toContain(
      ": number"
    );
  });

  it.each([
    "const recipe = require('./recipe'); exports.x = recipe();",
    "import { recipe } from './barrel'; export const cls = recipe({color:'red'});",
    "import { Box } from './barrel'; export const App = () => <Box />;",
    "export const App = () => <div {...props} />;",
    String.raw`import {css} from "@mincho-js/\u0063ss"; export const x = css({});`
  ])("preserves candidate transformations: %s", async (source) => {
    expect(
      await canSkipMinchoTransform({
        filename: "/App.tsx",
        source,
        babel: { ...babel, jsxCssProp: true }
      })
    ).toBe(false);
  });

  it("does not skip user plugins or configured extraction registrations", async () => {
    const options = { filename: "/plain.ts", source: "export const x = 1;" };

    expect(
      await canSkipMinchoTransform({
        ...options,
        babel: { ...babel, plugins: [() => ({ visitor: {} })] }
      })
    ).toBe(false);
    expect(
      await canSkipMinchoTransform({
        ...options,
        babel: { ...babel, extractCalls: { custom: ["style"] } }
      })
    ).toBe(false);
  });

  it.each(["source", "cwd"])(
    "observes Babel configuration creation and deletion under %s",
    async (location) => {
      const root = await mkdtemp(join(tmpdir(), "mincho-eligibility-"));
      directories.push(root);
      const configRoot =
        location === "source"
          ? root
          : await mkdtemp(join(tmpdir(), "mincho-eligibility-root-"));
      if (configRoot !== root) directories.push(configRoot);
      const cwd = vi.spyOn(process, "cwd").mockReturnValue(configRoot);

      try {
        const options = {
          filename: join(root, "plain.ts"),
          source: "export const x = 1;",
          babel: { compilationCache: new CompilationCache() }
        };

        expect(await canSkipMinchoTransform(options)).toBe(true);

        await writeFile(join(configRoot, "babel.config.json"), "{}");

        expect(await canSkipMinchoTransform(options)).toBe(false);

        await rm(join(configRoot, "babel.config.json"));

        expect(await canSkipMinchoTransform(options)).toBe(true);
      } finally {
        cwd.mockRestore();
      }
    }
  );

  it("shares facts across environments while keeping their result cache lifetimes independent", async () => {
    const observe = vi.fn();
    const parser = new InternalSourceAstCache(observe);
    const client = new CompilationCache(undefined, undefined, parser);
    const ssr = new CompilationCache(undefined, undefined, parser);
    const options = { filename: "/plain.ts", source: "export const size = 2;" };
    await canSkipMinchoTransform({
      ...options,
      babel: {
        ...babel,
        compilationCache: client,
        compilationContext: "client"
      }
    });
    client.clear();
    await canSkipMinchoTransform({
      ...options,
      babel: { ...babel, compilationCache: ssr, compilationContext: "ssr" }
    });

    expect(observe).toHaveBeenCalledWith(true, "analysis");
  });
});
