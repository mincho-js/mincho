import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  beginDefineRulesRegistrySession,
  endDefineRulesRegistrySession,
  getActiveDefineRulesRegistrySession
} from "@mincho-js/css/defineRules/registry";
import { transform } from "esbuild";
import { describe, expect, it } from "vitest";
import { runDefineRulesPresetRegistryStep } from "./defineRulesRegistryQueue.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((fulfill) => {
    resolve = fulfill;
  });

  return { promise, resolve };
}

describe("shared defineRules registry queue", () => {
  it("rejects awaited reentrant enqueue without blocking later callers", async () => {
    let nestedCalls = 0;
    const nested = runDefineRulesPresetRegistryStep(async () => {
      await Promise.resolve();

      return runDefineRulesPresetRegistryStep(() => nestedCalls++);
    });

    const following = runDefineRulesPresetRegistryStep(() => "following");

    await expect(nested).rejects.toThrow(
      "Cannot enqueue a defineRules registry step from an active registry step"
    );
    await expect(following).resolves.toBe("following");
    expect(nestedCalls).toBe(0);
  });

  it("permits ordinary nested registry begin/end sessions", async () => {
    await runDefineRulesPresetRegistryStep(async () => {
      const outer = beginDefineRulesRegistrySession();

      try {
        const inner = beginDefineRulesRegistrySession();

        try {
          await Promise.resolve();

          expect(getActiveDefineRulesRegistrySession()).toBe(inner);
        } finally {
          endDefineRulesRegistrySession();
        }

        expect(getActiveDefineRulesRegistrySession()).toBe(outer);
      } finally {
        endDefineRulesRegistrySession();
      }
    });

    expect(getActiveDefineRulesRegistrySession()).toBeUndefined();
  });

  it("allows detached async descendants to enqueue after their original step ends", async () => {
    const gate = deferred();
    let detached!: Promise<string>;
    await runDefineRulesPresetRegistryStep(() => {
      detached = (async () => {
        await gate.promise;

        return runDefineRulesPresetRegistryStep(() => "detached");
      })();
    });
    gate.resolve();

    await expect(detached).resolves.toBe("detached");
  });

  it("shares serialization, rejection recovery and reentrancy checks between real ESM/CJS copies", async () => {
    const directory = await fs.mkdtemp(
      join(tmpdir(), "mincho-registry-queue-")
    );

    try {
      const source = await fs.readFile(
        // This source test also participates in CommonJS declaration builds.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore error TS1343
        new URL("./defineRulesRegistryQueue.ts", import.meta.url),
        "utf8"
      );

      const outputs = await Promise.all(
        (["esm", "cjs"] as const).map((format) =>
          transform(source, { format, loader: "ts", target: "node20" })
        )
      );

      await Promise.all([
        fs.writeFile(join(directory, "queue.mjs"), outputs[0].code),
        fs.writeFile(join(directory, "queue.cjs"), outputs[1].code)
      ]);

      const script = `
        import assert from "node:assert/strict";
        import { createRequire } from "node:module";
        import { pathToFileURL } from "node:url";
        import { setImmediate } from "node:timers/promises";
        const { runDefineRulesPresetRegistryStep: esm } = await import(pathToFileURL(${JSON.stringify(join(directory, "queue.mjs"))}).href);
        const { runDefineRulesPresetRegistryStep: cjs } = createRequire(import.meta.url)(${JSON.stringify(join(directory, "queue.cjs"))});
        let release;
        const gate = new Promise(resolve => { release = resolve; });
        let active = 0;
        let maximum = 0;
        const events = [];
        const first = esm(async () => {
          maximum = Math.max(maximum, ++active);
          events.push("esm:start");
          await gate;
          events.push("esm:end");
          active--;
          throw new Error("expected failure");
        });
        const rejected = assert.rejects(first, /expected failure/);
        const second = cjs(async () => {
          maximum = Math.max(maximum, ++active);
          events.push("cjs:start");
          await setImmediate();
          events.push("cjs:end");
          active--;
          return "recovered";
        });
        await setImmediate();
        assert.deepEqual(events, ["esm:start"]);
        release();
        await rejected;
        assert.equal(await second, "recovered");
        assert.equal(maximum, 1);
        assert.deepEqual(events, ["esm:start", "esm:end", "cjs:start", "cjs:end"]);
        await assert.rejects(esm(() => cjs(() => "unreachable")), /active registry step/);
        assert.equal(await cjs(() => "after nested rejection"), "after nested rejection");
        process.stdout.write("shared queue verified");
      `;

      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--input-type=module", "--eval", script],
        { timeout: 10_000 }
      );

      expect(stdout).toBe("shared queue verified");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
