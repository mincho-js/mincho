import { describe, expect, it } from "vitest";
import { parseDefineRulesPresetArtifactV5 } from "./presetArtifact.js";

describe("V5 preset artifact diagnostics", () => {
  it("reports the failing field without a misleading version prefix", () => {
    expect(() =>
      parseDefineRulesPresetArtifactV5({
        schema: "mincho.defineRulesPreset",
        version: 4,
        rootNodeId: "bad",
        nodes: []
      })
    ).toThrow(
      /^Invalid defineRules preset at \$\.version: expected defineRules preset version 5$/
    );
    expect(() =>
      parseDefineRulesPresetArtifactV5({
        schema: "mincho.defineRulesPreset",
        version: 5,
        rootNodeId: "bad",
        nodes: []
      })
    ).toThrow(
      /^Invalid defineRules preset at \$\.rootNodeId: expected a SHA-256 hash$/
    );
    const versionAccessor = Object.defineProperty(
      {
        schema: "mincho.defineRulesPreset",
        rootNodeId: "bad",
        nodes: []
      },
      "version",
      {
        enumerable: true,
        get() {
          return 5;
        }
      }
    );
    expect(() => parseDefineRulesPresetArtifactV5(versionAccessor)).toThrow(
      /^Invalid defineRules preset at \$\.version: accessors are unsupported$/
    );
  });
});
