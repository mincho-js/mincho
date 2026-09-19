import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { babelTransformSource } from "./babel.js";
import { CompilationCache } from "./compilationCache.js";
import { CompilationDiagnostics } from "./diagnostics.js";

describe("semantic transform dependencies", () => {
  it("reuses a consumer after an unused export changes, refreshing its source snapshot", async ({
    onTestFinished
  }) => {
    const root = await mkdtemp(join(tmpdir(), "mincho-semantic-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));

    const file = join(root, "tokens.ts");
    let source =
      'export const styles = {button:{color:"red"},card:{color:"blue"}}; export const unused = 1;';

    const cache = new CompilationCache();
    const diagnostics = new CompilationDiagnostics({ console: true });

    const run = () =>
      diagnostics.run("/App.tsx", "test", () =>
        babelTransformSource({
          filename: join(root, "App.tsx"),
          source:
            'import {styles} from "./tokens"; export const App = () => <div css={styles.button} />;',
          babel: {
            cwd: root,
            compilationCache: cache,
            jsxCssProp: true,
            staticCssEvalSourceProvider: {
              resolve: () => ({ id: file, version: source }),

              load: () => ({ source, version: source })
            }
          }
        })
      );

    const first = await run();
    source = source
      .replace('"blue"', '"green"')
      .replace("unused = 1", "unused = 2");
    cache.invalidate(file);

    const second = await run();

    expect(second.code).toBe(first.code);
    expect(second.result).toEqual(first.result);
    expect(second.staticCssEval?.resolvedModuleCache.get(file)?.source).toBe(
      source
    );
    expect(second.staticCssEval?.resolvedModuleCache.get(file)?.version).toBe(
      source
    );

    const events = () =>
      diagnostics.snapshot().builds.flatMap((build) => build.events);

    expect(events().filter((event) => event.phase === "babel")).toHaveLength(1);
    expect(
      events().some((event) => event.phase === "semantic-dependency-hit")
    ).toBe(true);

    source = source.replace('"red"', '"orange"');
    cache.invalidate(file);

    expect((await run()).result).not.toEqual(first.result);
    expect(events().filter((event) => event.phase === "babel")).toHaveLength(2);

    source += "\nexport const extra = unknownEffect();";
    cache.invalidate(file);
    await run();

    expect(events().filter((event) => event.phase === "babel")).toHaveLength(3);
  });
});
