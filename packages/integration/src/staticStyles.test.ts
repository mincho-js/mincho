import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createStaticStyleSource,
  readStaticStyleProgram
} from "./staticStyles.js";

const manifestVersion = vi.hoisted(() => ({ value: "0.2.2" }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();

  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const contents = actual.readFileSync(...args);
      if (
        typeof contents !== "string" ||
        basename(String(args[0])) !== "package.json"
      )
        return contents;

      const manifest = JSON.parse(contents);

      return manifest.name === "@mincho-js/css"
        ? JSON.stringify({ ...manifest, version: manifestVersion.value })
        : contents;
    }
  };
});

function staticSource() {
  const filePath = join(process.cwd(), "release-static-styles.css.ts");

  return createStaticStyleSource({
    contents:
      "import {css} from '@mincho-js/css'; export const box=css({color:'red'});",
    filePath,
    originalPath: filePath,
    rootPath: process.cwd(),
    packageName: "release-static-styles"
  });
}

describe("static-style package versions", () => {
  it.each(["0.2.2", "1.0.0"])(
    "retains the static authoring program for validated CSS %s",
    (version) => {
      manifestVersion.value = version;
      const source = staticSource();

      expect(readStaticStyleProgram(source!)?.modules).toEqual([
        "@mincho-js/css"
      ]);
    }
  );

  it.each(["0.2.3", "1.0.1", "2.0.0"])(
    "falls back to evaluation for unvalidated CSS %s",
    (version) => {
      manifestVersion.value = version;

      expect(staticSource()).toBeUndefined();
    }
  );
});
