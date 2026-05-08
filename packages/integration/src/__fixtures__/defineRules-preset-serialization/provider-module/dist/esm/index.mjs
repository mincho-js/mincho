import { defineRules } from "@mincho-js/css";
const providerPresetArtifact = {"schema":"mincho.defineRulesPreset","version":4,"classNameByCache":{"156i5a4":"qm85120","1fzq9ac":"qm85121"},"writeKeyByCacheKey":{"156i5a4":0,"1fzq9ac":1},"conditionById":{"0":{"layer":null,"supports":null,"media":null,"container":null,"selector":"&"}},"propertyById":{"0":"color","1":"display"},"writeKeyById":{"0":{"conditionId":0,"propertyId":0},"1":{"conditionId":0,"propertyId":1}}};
export const sharedPreset = defineRules({ debugId: "provider-module", properties: { color: true, display: true }, presets: [providerPresetArtifact] });
export const preset = sharedPreset;
export const { css: sharedCss } = sharedPreset;
export const css = sharedCss;
export const shared = "qm85120 qm85121";
