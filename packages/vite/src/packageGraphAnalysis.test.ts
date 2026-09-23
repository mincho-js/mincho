import { once } from "node:events";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";
import type {
  Worker as WorkerInstance,
  WorkerOptions
} from "node:worker_threads";
import type { DefineRulesPackageGraph } from "@mincho-js/integration/package-graph";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPackageGraphAnalysis,
  type PackageGraphAnalysis,
  type PackageGraphAnalysisMode
} from "./packageGraphAnalysis.js";
import type { PackageGraphWorkerResponse } from "./packageGraphAnalysisCore.js";

const tracked = vi.hoisted(() => ({
  workers: [] as WorkerInstance[],
  holdAnalysis: false
}));

vi.mock("node:worker_threads", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:worker_threads")>();

  return {
    ...original,
    Worker: class extends original.Worker {
      constructor(filename: string | URL, options?: WorkerOptions) {
        super(filename, options);
        tracked.workers.push(this);
      }

      override postMessage(...args: Parameters<WorkerInstance["postMessage"]>) {
        const [command] = args;

        // A deliberate transport interruption keeps a request pending while
        // the real worker exits, so error cleanup has a deterministic test.
        if (tracked.holdAnalysis && command?.type === "analyze") return;

        super.postMessage(...args);
      }
    }
  };
});

const sessions: PackageGraphAnalysis[] = [];

afterEach(async () => {
  tracked.holdAnalysis = false;
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  tracked.workers.splice(0);
});

function create(mode: PackageGraphAnalysisMode): PackageGraphAnalysis {
  const session = createPackageGraphAnalysis({ mode });
  sessions.push(session);

  return session;
}

function chain(packages: readonly string[]): DefineRulesPackageGraph {
  return {
    packages: packages.map((packageName, firstSeen) => ({
      packageName,
      firstSeen
    })),
    dependencies: packages.slice(1).map((dependent, index) => ({
      dependency: packages[index]!,
      dependent,
      witnesses: [
        {
          parentOrigin: `${packages[index]}:parent`,
          childOrigin: `${dependent}:child`,
          parentNodeId: `${packages[index]}-node`,
          childNodeId: `${dependent}-node`,
          owner: `/virtual/${dependent}.css.ts?client`
        }
      ]
    })),
    localPackages: [packages[packages.length - 1]!]
  };
}

describe.each(["auto", "inline", "worker"] as const)(
  "%s package graph analysis",
  (mode) => {
    it("uses output declaration order rather than registration arrival order", async () => {
      const analysis = create(mode);
      const generation = analysis.beginGeneration();
      analysis.register({
        generation,
        moduleId: "second",
        graph: chain(["b", "app"])
      });
      analysis.register({
        generation,
        moduleId: "first",
        graph: chain(["a", "app"])
      });

      const result = await analysis.analyze({
        generation,
        moduleIds: ["ordinary.js", "first", "second", "first"]
      });

      expect(result.styleSpecifiers).toEqual(["a/style.css", "b/style.css"]);
      expect(result.graph.packages.map((item) => item.packageName)).toEqual([
        "a",
        "app",
        "b"
      ]);
    });

    it("checks cycles within each output and retains witness diagnostics", async () => {
      const analysis = create(mode);
      const generation = analysis.beginGeneration();
      analysis.register({
        generation,
        moduleId: "left",
        graph: chain(["a", "b", "app-left"])
      });
      analysis.register({
        generation,
        moduleId: "right",
        graph: chain(["b", "a", "app-right"])
      });

      expect(
        (await analysis.analyze({ generation, moduleIds: ["left"] }))
          .styleSpecifiers
      ).toEqual(["a/style.css", "b/style.css"]);
      expect(
        (await analysis.analyze({ generation, moduleIds: ["right"] }))
          .styleSpecifiers
      ).toEqual(["b/style.css", "a/style.css"]);
      await expect(
        analysis.analyze({
          generation,
          moduleIds: ["left", "right"],
          excludePackages: ["a", "b", "app-left", "app-right"]
        })
      ).rejects.toThrow(/package dependency cycle.*a.*b/s);
      await expect(
        analysis.analyze({ generation, moduleIds: ["left", "right"] })
      ).rejects.toThrow(/\/virtual\/.+\.css\.ts\?client/);

      // A diagnosed graph does not poison the reusable analyzer.
      expect(
        (await analysis.analyze({ generation, moduleIds: ["left"] }))
          .styleSpecifiers
      ).toEqual(["a/style.css", "b/style.css"]);
    });

    it("preserves complete module identities and explicit local exclusions", async () => {
      const analysis = create(mode);
      const generation = analysis.beginGeneration();
      analysis.register({
        generation,
        moduleId: "virtual:entry.ts?client",
        graph: chain(["client", "app"])
      });
      analysis.register({
        generation,
        moduleId: "virtual:entry.ts?server",
        graph: chain(["server", "app"])
      });

      expect(
        (
          await analysis.analyze({
            generation,
            moduleIds: ["virtual:entry.ts?server"],
            excludePackages: []
          })
        ).styleSpecifiers
      ).toEqual(["server/style.css", "app/style.css"]);

      analysis.remove({ generation, moduleId: "virtual:entry.ts?server" });

      expect(
        (
          await analysis.analyze({
            generation,
            moduleIds: ["virtual:entry.ts?client", "virtual:entry.ts?server"]
          })
        ).styleSpecifiers
      ).toEqual(["client/style.css"]);
    });

    it("snapshots registration and request ordering consistently", async () => {
      const analysis = create(mode);
      const generation = analysis.beginGeneration();
      const graph = chain(["before", "app"]);
      analysis.register({ generation, moduleId: "owner", graph });
      (graph.packages[0] as { packageName: string }).packageName = "mutated";

      const result = analysis.analyze({ generation, moduleIds: ["owner"] });
      analysis.remove({ generation, moduleId: "owner" });

      expect((await result).styleSpecifiers).toEqual(["before/style.css"]);
      expect(
        (await analysis.analyze({ generation, moduleIds: ["owner"] }))
          .styleSpecifiers
      ).toEqual([]);
    });

    it("rejects stale requests and ignores registrations from previous builds", async () => {
      const analysis = create(mode);
      const previous = analysis.beginGeneration();
      analysis.register({
        generation: previous,
        moduleId: "old",
        graph: chain(["old", "app"])
      });

      const pending = analysis.analyze({
        generation: previous,
        moduleIds: ["old"]
      });

      const rejected = expect(pending).rejects.toMatchObject({
        name: "PackageGraphAnalysisStaleGenerationError"
      });

      const generation = analysis.beginGeneration();
      await rejected;

      expect(
        analysis.register({
          generation: previous,
          moduleId: "late",
          graph: chain(["late", "app"])
        })
      ).toBe(false);
      expect(analysis.remove({ generation: previous, moduleId: "old" })).toBe(
        false
      );
      await expect(
        analysis.analyze({ generation: previous, moduleIds: ["old"] })
      ).rejects.toMatchObject({
        name: "PackageGraphAnalysisStaleGenerationError"
      });

      analysis.register({
        generation,
        moduleId: "new",
        graph: chain(["new", "app"])
      });

      expect(
        (
          await analysis.analyze({
            generation,
            moduleIds: ["old", "late", "new"]
          })
        ).styleSpecifiers
      ).toEqual(["new/style.css"]);
    });

    it("closes pending work and remains closed", async () => {
      const analysis = create(mode);
      const generation = analysis.beginGeneration();
      const pending = analysis.analyze({ generation, moduleIds: [] });
      const rejected = expect(pending).rejects.toMatchObject({
        name: "PackageGraphAnalysisClosedError"
      });

      await analysis.close();
      await rejected;
      await analysis.close();

      expect(
        analysis.register({
          generation,
          moduleId: "owner",
          graph: chain(["a", "app"])
        })
      ).toBe(false);
      expect(() => analysis.beginGeneration()).toThrow("closed");
      await expect(
        analysis.analyze({ generation, moduleIds: [] })
      ).rejects.toThrow("closed");
    });
  }
);

describe("worker lifecycle", () => {
  it("starts lazily and reuses one worker across output requests and builds", async () => {
    const analysis = create("worker");
    const first = analysis.beginGeneration();
    analysis.remove({ generation: first, moduleId: "ordinary.js" });

    expect(
      (await analysis.analyze({ generation: first, moduleIds: [] }))
        .styleSpecifiers
    ).toEqual([]);
    expect(tracked.workers).toHaveLength(0);

    analysis.register({
      generation: first,
      moduleId: "owner",
      graph: chain(["a", "app"])
    });
    await analysis.analyze({ generation: first, moduleIds: ["owner"] });
    await analysis.analyze({ generation: first, moduleIds: [] });

    const second = analysis.beginGeneration();
    analysis.register({
      generation: second,
      moduleId: "owner",
      graph: chain(["b", "app"])
    });

    expect(
      (await analysis.analyze({ generation: second, moduleIds: ["owner"] }))
        .styleSpecifiers
    ).toEqual(["b/style.css"]);
    expect(tracked.workers).toHaveLength(1);
  });

  it("rejects pending requests on worker exit and recovers in a new generation", async () => {
    const analysis = create("worker");
    const generation = analysis.beginGeneration();
    analysis.register({
      generation,
      moduleId: "owner",
      graph: chain(["a", "app"])
    });
    await analysis.analyze({ generation, moduleIds: ["owner"] });
    tracked.holdAnalysis = true;

    const pending = analysis.analyze({ generation, moduleIds: ["owner"] });
    const rejected = expect(pending).rejects.toThrow("exited unexpectedly");
    await tracked.workers[0]!.terminate();
    await rejected;

    await expect(
      analysis.analyze({ generation, moduleIds: ["owner"] })
    ).rejects.toThrow("exited unexpectedly");

    tracked.holdAnalysis = false;

    const next = analysis.beginGeneration();
    analysis.register({
      generation: next,
      moduleId: "owner",
      graph: chain(["b", "app"])
    });

    expect(
      (await analysis.analyze({ generation: next, moduleIds: ["owner"] }))
        .styleSpecifiers
    ).toEqual(["b/style.css"]);
    expect(tracked.workers).toHaveLength(2);
  });

  it("terminates an active worker and rejects pending analysis on close", async () => {
    const analysis = create("worker");
    const generation = analysis.beginGeneration();
    analysis.register({
      generation,
      moduleId: "owner",
      graph: chain(["a", "app"])
    });
    await analysis.analyze({ generation, moduleIds: ["owner"] });
    tracked.holdAnalysis = true;

    const pending = analysis.analyze({ generation, moduleIds: ["owner"] });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "PackageGraphAnalysisClosedError"
    });
    const exited = once(tracked.workers[0]!, "exit");
    const closing = analysis.close();

    expect(analysis.close()).toBe(closing);

    await Promise.all([closing, rejected, exited]);

    expect(tracked.workers[0]!.threadId).toBe(-1);
    expect(analysis.remove({ generation, moduleId: "owner" })).toBe(false);
    await expect(
      analysis.analyze({ generation, moduleIds: ["owner"] })
    ).rejects.toMatchObject({ name: "PackageGraphAnalysisClosedError" });
  });
});

describe.each([
  ["ESM", "esm/packageGraphWorker.mjs"],
  ["CommonJS", "cjs/packageGraphWorker.cjs"]
])("%s worker artifact", (_format, entryPath) => {
  it("boots the graph-only entry with the inherited strict PnP loader", async () => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore: declaration builds also check this source with a CommonJS target.
    const sourceDirectory = dirname(fileURLToPath(import.meta.url));
    const worker = new NodeWorker(join(sourceDirectory, "../dist", entryPath));

    try {
      const response = once(worker, "message");
      worker.postMessage({ type: "reset", generation: 1 });
      worker.postMessage({
        type: "register",
        generation: 1,
        moduleId: "virtual:entry?client",
        graph: chain(["a", "app"])
      });
      worker.postMessage({
        type: "analyze",
        generation: 1,
        requestId: 1,
        moduleIds: ["virtual:entry?client"]
      });

      const [result] = (await response) as [PackageGraphWorkerResponse];

      expect(result).toMatchObject({
        type: "result",
        generation: 1,
        requestId: 1,
        result: { styleSpecifiers: ["a/style.css"] }
      });
    } finally {
      await worker.terminate();
    }
  });
});

describe("automatic analysis", () => {
  it.each(["worker", "inline"] as const)(
    "preserves snapshots while shared CPU scheduling selects %s",
    async (selected) => {
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });

      const analysis = createPackageGraphAnalysis({
        mode: "worker",

        schedule: async (_bytes, worker, inline) => {
          await ready;

          return selected === "worker" ? worker() : inline();
        }
      });

      sessions.push(analysis);

      const generation = analysis.beginGeneration();
      analysis.register({
        generation,
        moduleId: "owner",
        graph: chain(["before", "app"])
      });

      const request = { generation, moduleIds: ["owner"] };
      const pending = analysis.analyze(request);
      request.moduleIds.length = 0;
      analysis.register({
        generation,
        moduleId: "owner",
        graph: chain(["after", "app"])
      });
      release();

      expect((await pending).styleSpecifiers).toEqual(["before/style.css"]);
      expect(
        (await analysis.analyze({ generation, moduleIds: ["owner"] }))
          .styleSpecifiers
      ).toEqual(["after/style.css"]);
    }
  );

  it("rejects analysis closed while waiting for the CPU budget", async () => {
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });

    const analysis = createPackageGraphAnalysis({
      mode: "worker",

      schedule: async (_bytes, worker) => {
        await ready;

        return worker();
      }
    });

    sessions.push(analysis);

    const generation = analysis.beginGeneration();
    analysis.register({
      generation,
      moduleId: "owner",
      graph: chain(["a", "app"])
    });

    const pending = analysis.analyze({ generation, moduleIds: ["owner"] });
    const rejected = expect(pending).rejects.toMatchObject({
      name: "PackageGraphAnalysisClosedError"
    });

    await analysis.close();
    release();
    await rejected;
  });

  it("uses selected graph bytes, keeps the boundary inline and lazily reuses workers", async () => {
    const analysis = create("auto");
    const generation = analysis.beginGeneration();
    const large = chain(["large", "app"]);
    const witness = large.dependencies[0]!.witnesses[0]! as { owner: string };
    witness.owner += "x".repeat(
      512 * 1024 - Buffer.byteLength(JSON.stringify(large))
    );
    analysis.register({ generation, moduleId: "boundary", graph: large });
    await analysis.analyze({ generation, moduleIds: ["boundary", "boundary"] });

    expect(tracked.workers).toHaveLength(0);

    witness.owner += "x";
    analysis.register({ generation, moduleId: "large", graph: large });
    analysis.register({
      generation,
      moduleId: "small",
      graph: chain(["small", "app"])
    });

    expect(
      (await analysis.analyze({ generation, moduleIds: ["small"] }))
        .styleSpecifiers
    ).toEqual(["small/style.css"]);
    expect(tracked.workers).toHaveLength(0);
    expect(
      (await analysis.analyze({ generation, moduleIds: ["large"] }))
        .styleSpecifiers
    ).toEqual(["large/style.css"]);

    await analysis.analyze({ generation, moduleIds: ["large"] });

    expect(tracked.workers).toHaveLength(1);

    analysis.remove({ generation, moduleId: "large" });

    expect(
      (await analysis.analyze({ generation, moduleIds: ["large", "small"] }))
        .styleSpecifiers
    ).toEqual(["small/style.css"]);
  });
});
