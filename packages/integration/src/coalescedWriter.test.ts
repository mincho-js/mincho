import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CoalescedAtomicWriter,
  type AtomicWriteEvent
} from "./coalescedWriter.js";
import { CompilationIoPool } from "./ioPool.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function directory() {
  const root = await mkdtemp(join(tmpdir(), "mincho-writer-"));
  directories.push(root);

  return root;
}

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });

  return { promise, release };
}

describe("coalesced atomic writes", () => {
  it("coordinates owners sharing a path without retaining completed writes", async () => {
    const file = join(await directory(), "shared");
    const first = new CoalescedAtomicWriter();
    const second = new CoalescedAtomicWriter();
    const old = vi.fn(() => "old");
    const pending = first.write(file, old);
    const latest = second.write(file, () => "latest");
    await Promise.all([first.flush(), second.flush(), pending, latest]);

    expect(old).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("latest");
    expect(await first.write(file, () => "next")).toBe("written");
    expect(await readFile(file, "utf8")).toBe("next");
  });

  it("coalesces one path before serialization and never merges different paths", async () => {
    const root = await directory();
    const writer = new CoalescedAtomicWriter();
    const events: AtomicWriteEvent[] = [];

    const observe = (event: AtomicWriteEvent) => events.push(event);

    const old = vi.fn(() => "old");
    const first = writer.write(join(root, "one"), old, { observe });
    const latest = writer.write(join(root, "one"), () => "new", { observe });
    const other = writer.write(join(root, "two"), () => "other", { observe });
    await writer.flush();

    expect(await Promise.all([first, latest, other])).toEqual([
      "written",
      "written",
      "written"
    ]);
    expect(old).not.toHaveBeenCalled();
    expect(await readFile(join(root, "one"), "utf8")).toBe("new");
    expect(await readFile(join(root, "two"), "utf8")).toBe("other");
    expect(events.filter((event) => event.kind === "written")).toHaveLength(2);
    expect(events.filter((event) => event.kind === "coalesced")).toHaveLength(
      1
    );
  });

  it("checks actual content before skipping and repairs changed or removed files", async () => {
    const file = join(await directory(), "result");
    const writer = new CoalescedAtomicWriter();
    await writer.write(file, () => "same");

    const original = await stat(file);

    expect(await writer.write(file, () => "same")).toBe("unchanged");
    expect((await stat(file)).ino).toBe(original.ino);

    await writeFile(file, "corrupt");

    expect(await writer.write(file, () => "same")).toBe("written");

    await rm(file);

    expect(await writer.write(file, () => "same")).toBe("written");
  });

  it("rejects stale publication after queued I/O and drains the valid successor", async () => {
    const root = await directory();
    const io = new CompilationIoPool();
    const started = gate();
    const blocked = gate();
    vi.spyOn(io, "run").mockImplementationOnce(async (operation) => {
      started.release();
      await blocked.promise;

      return operation();
    });

    const writer = new CoalescedAtomicWriter(io);
    let generation = 1;
    const file = join(root, "result");
    const first = writer.write(file, () => "old", {
      isCurrent: () => generation === 1
    });

    await started.promise;
    generation = 2;

    const second = writer.write(file, () => "new", {
      isCurrent: () => generation === 2
    });

    // A late request from an invalid generation cannot supersede the valid one.
    expect(
      await writer.write(file, () => "stale", { isCurrent: () => false })
    ).toBe("stale");

    const drained = writer.flush();
    blocked.release();
    await drained;

    expect(await first).toBe("stale");
    expect(await second).toBe("written");
    expect(await readFile(file, "utf8")).toBe("new");
    expect(await readdir(root)).toEqual(["result"]);
  });

  it("does not poison a path after an I/O failure", async () => {
    const root = await directory();
    const blocker = join(root, "parent");
    await writeFile(blocker, "file");

    const writer = new CoalescedAtomicWriter();
    const file = join(blocker, "result");

    await expect(writer.write(file, () => "fail")).rejects.toThrow();

    await writer.flush();
    await rm(blocker);

    expect(await writer.write(file, () => "recovered")).toBe("written");

    await writer.flush();

    expect(await readFile(file, "utf8")).toBe("recovered");
  });
});
