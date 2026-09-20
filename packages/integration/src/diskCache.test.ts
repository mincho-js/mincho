import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { deserialize, serialize } from "node:v8";
import { afterEach, expect, it } from "vitest";
import { CompilationDiskCache, type PersistentEntry } from "./diskCache.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true }))
  );
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "mincho-disk-"));
  directories.push(path);

  return path;
}

const entry = (value: unknown): PersistentEntry => ({
  value,
  owner: "/source.ts",
  bytes: 100,
  dependencies: ["/source.ts"],
  manifest: { fingerprints: [["/source.ts", "hash"]] }
});

it("reuses structured data across cache instances and isolates compiler identities", async () => {
  const path = await directory();
  const original = entry({
    map: new Map([["file", "source"]]),
    bytes: Buffer.from("compiled")
  });

  await new CompilationDiskCache(path, "compiler1").put(
    "transform:key",
    original
  );

  expect(
    await new CompilationDiskCache(path, "compiler1").get("transform:key")
  ).toEqual(original);
  expect(
    await new CompilationDiskCache(path, "compiler2").get("transform:key")
  ).toBeUndefined();
});

it("treats truncated and corrupted entries as misses without leaving partial writes", async () => {
  const path = await directory();
  const cache = new CompilationDiskCache(path, "compiler");
  await cache.put("key", entry("result"));

  const [name] = await readdir(path);
  const file = join(path, name);
  const bytes = await readFile(file);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(file, bytes);

  expect(await cache.get("key")).toBeUndefined();

  await writeFile(file, "partial");

  expect(await cache.get("key")).toBeUndefined();
  expect(
    (await readdir(path)).every((name) => name.endsWith(".mincho-cache"))
  ).toBe(true);
});

it("evicts to the configured byte limit and tolerates concurrent publishers", async () => {
  const path = await directory();
  const cache = new CompilationDiskCache(path, "compiler", 1100);
  const other = new CompilationDiskCache(path, "compiler", 1100);
  await Promise.all([
    cache.put("one", entry("x".repeat(400))),
    other.put("two", entry("y".repeat(400)))
  ]);
  await cache.flush();

  const files = await readdir(path);

  expect(files.length).toBeLessThan(2);
  expect(files.length).toBeGreaterThan(0);
});

it("treats an unwritable directory as an optional cache", async () => {
  const path = await directory();
  const file = join(path, "file");
  await writeFile(file, "not a directory");

  const cache = new CompilationDiskCache(file, "compiler");

  await expect(cache.put("key", entry("result"))).resolves.toBeUndefined();
  expect(await cache.get("key")).toBeUndefined();
});

it.each(["format", "manifest"])(
  "rejects incompatible %s even with a valid checksum",
  async (invalid) => {
    const path = await directory();
    const cache = new CompilationDiskCache(path, "compiler");
    await cache.put("key", entry("result"));

    const [name] = await readdir(path);
    const file = join(path, name);
    const record = deserialize((await readFile(file)).subarray(65));

    if (invalid === "format") record.format = "old-format";
    else record.entry.manifest.semanticFiles = [null];

    const payload = serialize(record);
    const checksum = createHash("sha256").update(payload).digest("hex");
    await writeFile(
      file,
      Buffer.concat([Buffer.from(checksum + "\n"), payload])
    );

    expect(await cache.get("key")).toBeUndefined();

    await cache.put("key", entry("recovered"));

    expect((await cache.get("key"))?.value).toBe("recovered");
  }
);

it("ignores an interrupted writer's temporary file and can publish again", async () => {
  const path = await directory();
  const cache = new CompilationDiskCache(path, "compiler");
  await cache.put("key", entry("complete"));

  const [name] = await readdir(path);
  await writeFile(join(path, `${name}.abandoned.tmp`), "partial");

  expect((await cache.get("key"))?.value).toBe("complete");

  await cache.put("key", entry("recovered"));
  await cache.flush();

  expect((await cache.get("key"))?.value).toBe("recovered");
});
