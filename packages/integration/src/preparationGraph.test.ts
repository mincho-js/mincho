import { expect, it } from "vitest";
import { PreparationGraph } from "./preparationGraph.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

it.each([2, 3])(
  "rejects a cycle between %s independent preparations even if a consumer catches its proof error",
  async (size) => {
    const graph = new PreparationGraph();
    const names = Array.from(
      { length: size },
      (_, index) => `file-${index}.tsx`
    );
    const tasks = new Map<string, Promise<string>>();
    const start = deferred<void>();
    for (const [index, name] of names.entries()) {
      tasks.set(
        name,
        graph.wait(undefined, name, async () => {
          await start.promise;
          try {
            const dependency = names[(index + 1) % size]!;
            await graph.wait(name, dependency, () => tasks.get(dependency)!);
          } catch {
            // Model an analyzer that deopts on a failed consumer-source proof.
          }
          return `export const className = "${name}";`;
        })
      );
    }
    start.resolve();
    const results = await Promise.allSettled(tasks.values());
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(String(result.reason)).toMatch(/Circular script preparation/);
    }
    graph.clear();
    expect(
      await graph.wait(undefined, names[0]!, async () => "rebuilt source")
    ).toBe("rebuilt source");
  }
);

it("retains a shared peer's complete generated source for independent readers", async () => {
  const graph = new PreparationGraph();
  const ready = deferred<string>();
  const readers = ["a.tsx", "b.tsx"].map((owner) =>
    graph.wait(owner, "shared.tsx", () => ready.promise)
  );
  const source = 'export const className = "compiled-class";';
  ready.resolve(source);
  expect(await Promise.all(readers)).toEqual([source, source]);
});

it("rejects every participant in branching hard cycles even if dependency errors are caught", async () => {
  const graph = new PreparationGraph();
  const dependencies: Record<string, string[]> = {
    a: ["b", "c"],
    b: ["d"],
    c: ["d"],
    d: ["a"],
    observer: ["c"]
  };
  const tasks = new Map<string, Promise<string>>();
  const start = deferred<void>();
  for (const [name, peers] of Object.entries(dependencies))
    tasks.set(
      name,
      graph.wait(undefined, name, async () => {
        await start.promise;
        await Promise.all(
          peers.map((peer) => graph.wait(name, peer, () => tasks.get(peer)!))
        ).catch(() => {});
        return `completed ${name}`;
      })
    );
  start.resolve();

  const results = await Promise.allSettled(tasks.values());
  for (const result of results.slice(0, 4)) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(String(result.reason)).toContain("Circular script preparation");
  }
  expect(results[4]).toEqual({
    status: "fulfilled",
    value: "completed observer"
  });
});

it("can decline optional cyclic proof without losing either completed source", async () => {
  const graph = new PreparationGraph();
  const peer = deferred<string>();
  const first = graph.wait("a", "b", () => peer.promise);
  const load = () => {
    throw new Error("Must not await the blocked owner");
  };
  expect(await graph.wait("b", "a", load, () => undefined)).toBeUndefined();
  peer.resolve("complete b");
  expect(await first).toBe("complete b");
  expect(await graph.wait("b", "a", async () => "complete a")).toBe(
    "complete a"
  );
});
