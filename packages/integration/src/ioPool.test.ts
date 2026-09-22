import { AsyncLocalStorage } from "node:async_hooks";
import { expect, it } from "vitest";
import { CompilationIoPool } from "./ioPool.js";

it("admits queued I/O through idle lanes while an earlier operation is stalled", async () => {
  const pool = new CompilationIoPool(3);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stalled = pool.run(() => gate);
  const completed = Array.from({ length: 63 }, () =>
    pool.run(async () => undefined)
  );
  let admitted = false;
  let queued: Promise<void> | undefined;

  try {
    await Promise.all(completed);
    queued = pool.run(async () => {
      admitted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(admitted).toBe(true);
  } finally {
    release();
    await Promise.all([stalled, ...completed, queued]);
  }
});

it("bounds finite batches while preserving caller context, results and errors", async () => {
  const pool = new CompilationIoPool(3);
  const context = new AsyncLocalStorage<number>();
  const failure = new Error("read failed");
  let active = 0;
  let peak = 0;
  const result = await Promise.allSettled(
    Array.from({ length: 145 }, (_, index) =>
      context.run(index, () =>
        pool.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise<void>((resolve) => setImmediate(resolve));
          active--;

          expect(context.getStore()).toBe(index);

          if (index === 12) throw failure;

          return index;
        })
      )
    )
  );

  expect(peak).toBe(3);
  expect(result[12]).toEqual({ status: "rejected", reason: failure });
  expect(result[144]).toEqual({ status: "fulfilled", value: 144 });
  expect(await pool.run(async () => "recovered")).toBe("recovered");
});
