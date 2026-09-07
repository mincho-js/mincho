import type {
  parseDefineRulesPresetArtifactV5 as parseEsmArtifact,
  DefineRulesRegistrySession as EsmRegistrySession
} from "@mincho-js/css/defineRules/registry" with {
  "resolution-mode": "import"
};
import type {
  parseDefineRulesPresetArtifactV5 as parseCjsArtifact,
  DefineRulesRegistrySession as CjsRegistrySession
} from "@mincho-js/css/defineRules/registry" with {
  "resolution-mode": "require"
};
import type { DefineRulesPresetArtifactV5 as EsmRootArtifact } from "@mincho-js/css" with {
  "resolution-mode": "import"
};
import type { DefineRulesPresetArtifactV5 as CjsRootArtifact } from "@mincho-js/css" with {
  "resolution-mode": "require"
};
import type {
  collectDefineRulesPackageGraph as collectEsmGraph,
  getDefineRulesAncestorStyleSpecifiers as getEsmStyles
} from "@mincho-js/integration" with {
  "resolution-mode": "import"
};
import type {
  collectDefineRulesPackageGraph as collectCjsGraph,
  getDefineRulesAncestorStyleSpecifiers as getCjsStyles
} from "@mincho-js/integration" with {
  "resolution-mode": "require"
};

declare const esmArtifact: ReturnType<typeof parseEsmArtifact>;
declare const cjsArtifact: ReturnType<typeof parseCjsArtifact>;
declare const esmRootArtifact: EsmRootArtifact;
declare const cjsRootArtifact: CjsRootArtifact;
declare const esmSession: EsmRegistrySession;
declare const cjsSession: CjsRegistrySession;

export const esmGraphInputs: Parameters<typeof collectEsmGraph>[0] = [
  esmArtifact,
  cjsArtifact,
  esmRootArtifact,
  cjsRootArtifact
];

export const cjsGraphInputs: Parameters<typeof collectCjsGraph>[0] = [
  esmArtifact,
  cjsArtifact,
  esmRootArtifact,
  cjsRootArtifact
];

export const esmRegistryInputs: Parameters<typeof getEsmStyles>[0][] = [
  esmSession,
  cjsSession
];

export const cjsRegistryInputs: Parameters<typeof getCjsStyles>[0][] = [
  esmSession,
  cjsSession
];
