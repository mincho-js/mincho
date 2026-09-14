import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { resolveFromModule } from "./moduleResolution.js";

it("anchors relative resolution to each caller instead of cwd or the utility", async () => {
  const root = await mkdtemp(join(tmpdir(), "mincho-module-resolution-"));

  try {
    for (const name of ["first", "second"]) {
      const directory = join(root, name);
      await mkdir(directory);

      const dependency = join(directory, "dependency.js");
      await writeFile(dependency, "module.exports = 1;");

      expect(
        resolveFromModule(
          pathToFileURL(join(directory, "caller.js")),
          "./dependency.js"
        )
      ).toBe(dependency);
    }

    expect(() =>
      resolveFromModule(join(root, "caller.js"), "./missing.js")
    ).toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
