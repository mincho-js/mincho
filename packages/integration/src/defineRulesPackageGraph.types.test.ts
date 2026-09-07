import type {
  parseDefineRulesPresetArtifactV5 as parseEsmArtifact,
  DefineRulesRegistrySession as EsmRegistrySession
} from "@mincho-js/css/defineRules/registry" with {
  "resolution-mode": "import"
};
import type { DefineRulesPresetArtifactV5 as CssRootArtifact } from "@mincho-js/css";
import { expectTypeOf, it } from "vitest";
import type { collectDefineRulesPackageGraph } from "./defineRulesPackageGraph.js";
import type { getDefineRulesAncestorStyleSpecifiers } from "./defineRulesPreset.js";

// Cross-format declarations are checked against packed packages in
// scripts/package-contract/fixture/modules/preset-types.mts. A source-only
// TypeScript build emits ESM declarations before CJS artifacts exist.
it("accepts artifacts from ESM and the CSS root declaration entry", () => {
  type ArtifactInput = Parameters<
    typeof collectDefineRulesPackageGraph
  >[0][number];

  expectTypeOf<ReturnType<typeof parseEsmArtifact>>().toExtend<ArtifactInput>();
  expectTypeOf<CssRootArtifact>().toExtend<ArtifactInput>();
});

it("accepts registry sessions from the CSS declaration entry", () => {
  type RegistryInput = Parameters<
    typeof getDefineRulesAncestorStyleSpecifiers
  >[0];

  expectTypeOf<EsmRegistrySession>().toExtend<RegistryInput>();
});
