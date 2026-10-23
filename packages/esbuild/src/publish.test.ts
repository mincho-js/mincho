import { afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { OutputFile } from "esbuild";
import { publishOutputs } from "./publish.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();

  return {
    ...actual,
    writeFile: vi.fn(actual.writeFile),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm)
  };
});

const roots: string[] = [];

afterEach(async () => {
  vi.mocked(writeFile).mockReset().mockImplementation(fs.writeFile);
  vi.mocked(rename).mockReset().mockImplementation(fs.rename);
  vi.mocked(rm).mockReset().mockImplementation(fs.rm);
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function fixture() {
  const parent = resolve(process.cwd(), ".test-publish");
  await fs.mkdir(parent, { recursive: true });

  const root = await fs.mkdtemp(join(parent, "case-"));
  roots.push(root);
  await fs.writeFile(join(root, "one.js"), "previous one");
  await fs.writeFile(join(root, "two.js"), "previous two");

  return root;
}

function output(path: string, text: string): OutputFile {
  return { path, text, contents: Buffer.from(text), hash: "test" };
}

it("keeps the complete previous output visible until replacement", async () => {
  const root = await fixture();
  const path = join(root, "one.js");
  vi.mocked(writeFile).mockImplementationOnce(async (temporary, contents) => {
    expect(dirname(String(temporary))).toBe(root);
    await fs.writeFile(temporary, "partial output");
    expect(await fs.readFile(path, "utf8")).toBe("previous one");
    await fs.writeFile(temporary, contents);
  });

  await publishOutputs([output(path, "complete new output")]);

  expect(await fs.readFile(path, "utf8")).toBe("complete new output");
  expect((await fs.readdir(root)).sort()).toEqual(["one.js", "two.js"]);
});

it.skipIf(process.platform === "win32").each([0o755, 0o640])(
  "preserves an existing output mode of %i",
  async (mode) => {
    const root = await fixture();
    const path = join(root, "one.js");
    await fs.chmod(path, mode);

    await publishOutputs([output(path, "new output")]);

    expect(await fs.readFile(path, "utf8")).toBe("new output");
    expect((await fs.stat(path)).mode & 0o7777).toBe(mode);
    expect((await fs.readdir(root)).sort()).toEqual(["one.js", "two.js"]);
  }
);

it.each(["write", "rename"])(
  "cleans temporary files and restores earlier outputs after a %s failure",
  async (operation) => {
    const root = await fixture();
    await fs.chmod(join(root, "one.js"), 0o755);
    await fs.chmod(join(root, "two.js"), 0o640);
    if (operation === "write") {
      vi.mocked(writeFile)
        .mockImplementationOnce(fs.writeFile)
        .mockImplementationOnce(async (temporary) => {
          await fs.writeFile(temporary, "partial output");
          throw new Error("write failed");
        });
    } else {
      vi.mocked(rename)
        .mockImplementationOnce(fs.rename)
        .mockRejectedValueOnce(new Error("rename failed"));
    }

    await expect(
      publishOutputs([
        output(join(root, "one.js"), "new one"),
        output(join(root, "two.js"), "new two")
      ])
    ).rejects.toThrow("Touched output files were restored");

    expect(await fs.readFile(join(root, "one.js"), "utf8")).toBe(
      "previous one"
    );
    expect(await fs.readFile(join(root, "two.js"), "utf8")).toBe(
      "previous two"
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(join(root, "one.js"))).mode & 0o7777).toBe(0o755);
      expect((await fs.stat(join(root, "two.js"))).mode & 0o7777).toBe(0o640);
    }
    expect((await fs.readdir(root)).sort()).toEqual(["one.js", "two.js"]);
  }
);

it.each(["remove", "write", "rename"])(
  "restores retired files and their modes after a %s failure",
  async (operation) => {
    const root = await fixture();
    const manifest = join(root, "manifest.json");
    const css = join(root, "shared.css");
    await fs.writeFile(manifest, "previous manifest", { mode: 0o640 });
    await fs.writeFile(css, "previous CSS", { mode: 0o600 });

    if (operation === "remove")
      vi.mocked(rm)
        .mockImplementationOnce(fs.rm)
        .mockRejectedValueOnce(new Error("remove failed"));
    else if (operation === "write")
      vi.mocked(writeFile)
        .mockImplementationOnce(fs.writeFile)
        .mockRejectedValueOnce(new Error("write failed"));
    else
      vi.mocked(rename)
        .mockImplementationOnce(fs.rename)
        .mockRejectedValueOnce(new Error("rename failed"));

    await expect(
      publishOutputs(
        [
          output(join(root, "one.js"), "new one"),
          output(join(root, "two.js"), "new two")
        ],
        [manifest, css]
      )
    ).rejects.toThrow("Touched output files were restored");

    expect(await fs.readFile(manifest, "utf8")).toBe("previous manifest");
    expect(await fs.readFile(css, "utf8")).toBe("previous CSS");
    expect(await fs.readFile(join(root, "one.js"), "utf8")).toBe(
      "previous one"
    );
    expect(await fs.readFile(join(root, "two.js"), "utf8")).toBe(
      "previous two"
    );
    if (process.platform !== "win32") {
      expect((await fs.stat(manifest)).mode & 0o7777).toBe(0o640);
      expect((await fs.stat(css)).mode & 0o7777).toBe(0o600);
    }
    expect((await fs.readdir(root)).sort()).toEqual([
      "manifest.json",
      "one.js",
      "shared.css",
      "two.js"
    ]);
  }
);
