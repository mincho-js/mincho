import { defineRules } from "@mincho-js/css";
const providerPresetArtifact = {"schema":"mincho.defineRulesPreset","version":5,"rootNodeId":"06671bcf5f940574fe031180633669fc84c48af3c19b8b985f6130b2fb78295b","nodes":[{"nodeId":"06671bcf5f940574fe031180633669fc84c48af3c19b8b985f6130b2fb78295b","origin":"@mincho-js-proof/define-rules-preset:dist/index.js#defineRules:0","contentHash":"23ef2499ea914aada37fef3f7a42ebe2419bc22893329e2272b94e5409402ff1","parents":[],"atoms":[{"atomId":"c89538bcd7070cd65633e86752a9a8a6d6847237f5cd50feb52041b5c59be31f","cacheKey":"156i5a4","className":"qm85120","condition":{"layer":null,"supports":null,"media":null,"container":null,"selector":"&"},"property":"color"},{"atomId":"71670b65e112f4969c5e51086423166050e55a7fbad2d4a62ed42c385a279963","cacheKey":"1fzq9ac","className":"qm85121","condition":{"layer":null,"supports":null,"media":null,"container":null,"selector":"&"},"property":"display"}]}]};
export const sharedPreset = defineRules({ debugId: "provider-module", properties: { color: true, display: true }, presets: [providerPresetArtifact] });
export const preset = sharedPreset;
export const { css: sharedCss } = sharedPreset;
export const css = sharedCss;
export const shared = "qm85120 qm85121";
