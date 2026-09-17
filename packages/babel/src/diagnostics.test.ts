import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import { minchoBabelPlugin } from "./index.js";
import type { MinchoBabelFileMetadata } from "./types.js";

describe("Babel compilation metadata", () => {
  it("reports sidecar extraction only when requested", () => {
    for (const diagnostics of [false, true]) {
      const result = transformSync(
        'import { css } from "@mincho-js/css"; export const red = css({ color: "red" });',
        {
          filename: "/project/style.ts",
          configFile: false,
          babelrc: false,
          plugins: [[minchoBabelPlugin, { result: ["", ""], diagnostics }]]
        }
      );

      const metadata = result?.metadata as unknown as MinchoBabelFileMetadata;

      if (diagnostics) {
        expect(metadata.minchoCompilation).toMatchObject({
          extractedCalls: 1,
          jsxCssProp: false
        });
        expect(metadata.minchoCompilation?.sidecar).toMatch(/\.css\.ts$/);
      } else expect(metadata.minchoCompilation).toBeUndefined();
    }
  });
});
