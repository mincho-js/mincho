import { basename, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VanillaCssArtifact } from "./vanillaCssIr.js";

const versions = vi.hoisted(() => ({
  integration: "8.0.11",
  css: "1.21.3",
  unreadableCss: false
}));

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

      if (manifest.name === "@vanilla-extract/integration")
        return JSON.stringify({ ...manifest, version: versions.integration });

      if (manifest.name === "@vanilla-extract/css") {
        if (versions.unreadableCss) throw new Error("CSS manifest unavailable");

        return JSON.stringify({ ...manifest, version: versions.css });
      }

      return contents;
    }
  };
});

beforeEach(() => {
  vi.resetModules();
  versions.integration = "8.0.11";
  versions.css = "1.21.3";
  versions.unreadableCss = false;
});

const filePath = join(process.cwd(), "adapter-versions.css.ts");
const source = `
  const scope = require('@vanilla-extract/css/fileScope');
  scope.setFileScope('adapter-versions.css.ts', 'adapter-version-test');
  exports.box = require('@vanilla-extract/css').style({color: 'red'});
  scope.endFileScope();
`;

describe("vanilla-extract adapter compatibility", () => {
  it.each([
    ["8.0.10", "1.20.1"],
    ["8.0.10", "1.21.3"],
    ["8.0.11", "1.20.1"],
    ["8.0.11", "1.21.3"]
  ])(
    "collects artifacts with integration %s and CSS %s",
    async (integration, css) => {
      versions.integration = integration;
      versions.css = css;
      const { processVanillaWithExecution } =
        await import("./vanillaEvaluation.js");
      const serializeCssArtifact = vi.fn((_artifact: VanillaCssArtifact) => "");

      await processVanillaWithExecution({
        source,
        filePath,
        serializeCssArtifact
      });

      expect(serializeCssArtifact).toHaveBeenCalledOnce();
      expect(serializeCssArtifact.mock.calls[0]?.[0]).toMatchObject({
        cssObjs: [{ rule: { color: "red" } }]
      });
    }
  );

  it.each([
    ["1.21.2", false],
    ["1.21.2", true],
    ["2.0.0", false],
    ["2.0.0", true]
  ] as const)(
    "rejects CSS %s before evaluation with staticStyles=%s",
    async (css, staticStyles) => {
      versions.css = css;
      const { processVanillaWithExecution } =
        await import("./vanillaEvaluation.js");

      await expect(
        processVanillaWithExecution({
          filePath,
          source: 'throw new Error("Unexpected stylesheet execution")',
          staticStyles,
          serializeCssArtifact: () => ""
        })
      ).rejects.toThrow("Mincho dist-chunk requires the validated");
    }
  );

  it.each(["unsupported integration", "unreadable CSS manifest"])(
    "rejects artifact evaluation with %s",
    async (reason) => {
      if (reason === "unsupported integration") versions.integration = "9.0.0";
      else versions.unreadableCss = true;

      const { processVanillaWithExecution } =
        await import("./vanillaEvaluation.js");

      await expect(
        processVanillaWithExecution({
          filePath,
          source: 'throw new Error("Unexpected stylesheet execution")',
          serializeCssArtifact: () => ""
        })
      ).rejects.toThrow("Mincho dist-chunk requires the validated");
    }
  );

  it("retains native CSS evaluation for other adapter versions", async () => {
    versions.css = "2.0.0";
    const { processVanillaWithExecution } =
      await import("./vanillaEvaluation.js");
    const css: string[] = [];

    await processVanillaWithExecution({
      source,
      filePath,
      serializeVirtualCssPath: ({ source }) => {
        css.push(source);

        return "";
      }
    });

    expect(css).toHaveLength(1);
    expect(css[0]).toContain("color: red");
  });
});
