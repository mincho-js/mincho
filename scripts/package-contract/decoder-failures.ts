import { assertV5PresetOutput } from "./diamond-artifacts.js";
import { assertFailure as assertActionFailure } from "./assert-failure.js";

function assertFailure(
  label: string,
  expectedDetail: string,
  source: string
): void {
  assertActionFailure(
    label,
    expectedDetail,
    () => assertV5PresetOutput(source, "decoder failure fixture"),
    "Expected decoder failure did not fail"
  );
}

export function assertDecoderFailurePaths(v5PresetFixture: string): void {
  const unresolved = "not statically resolvable";
  const unsupported = "unsupported static export shape";

  assertFailure(
    "array destructuring assignment",
    unresolved,
    `let preset = ${v5PresetFixture};
     [preset] = [null];
     export { preset };`
  );
  assertFailure(
    "object destructuring assignment",
    unresolved,
    `let preset = ${v5PresetFixture};
     ({ value: preset } = { value: null });
     export { preset };`
  );
  assertFailure(
    "alias member mutation",
    unresolved,
    `const preset = ${v5PresetFixture};
     const alias = preset;
     alias.version = 4;
     export { preset };`
  );
  assertFailure(
    "nested alias mutation",
    unresolved,
    `const preset = ${v5PresetFixture};
     const nodes = preset.nodes;
     nodes[0] = null;
     export { preset };`
  );
  assertFailure(
    "object container mutation",
    unresolved,
    `const preset = ${v5PresetFixture};
     const holder = { preset };
     holder.preset.version = 4;
     export { preset };`
  );
  assertFailure(
    "array container mutation",
    unresolved,
    `const preset = ${v5PresetFixture};
     const holder = [preset];
     holder[0].version = 4;
     export { preset };`
  );
  assertFailure(
    "returned binding mutation",
    unresolved,
    `const preset = ${v5PresetFixture};
     (() => preset)().version = 4;
     export { preset };`
  );
  assertFailure(
    "spoofed readonly helper",
    unresolved,
    `const preset = ${v5PresetFixture};
     const createDefineRulesCssRuntime = ({ presets }) => {
       presets.version = 4;
     };
     createDefineRulesCssRuntime({ presets: preset });
     export { preset };`
  );
  assertFailure(
    "object assign mutation",
    unresolved,
    `const preset = ${v5PresetFixture};
     Object.assign(preset, { version: 4 });
     export { preset };`
  );
  assertFailure(
    "object define properties mutation",
    unresolved,
    `const preset = ${v5PresetFixture};
     Object.defineProperties(preset, { version: { value: 4 } });
     export { preset };`
  );
  assertFailure(
    "reflect define property mutation",
    unresolved,
    `const preset = ${v5PresetFixture};
     Reflect.defineProperty(preset, "version", { value: 4 });
     export { preset };`
  );
  assertFailure(
    "unknown call escape",
    unresolved,
    `const preset = ${v5PresetFixture};
     mutate(preset);
     export { preset };`
  );
  assertFailure(
    "member mutator call",
    unresolved,
    `export const preset = [${v5PresetFixture}];
     preset.push(null);`
  );
  assertFailure(
    "for-of rebinding",
    unresolved,
    `let preset = ${v5PresetFixture};
     for (preset of [null]) {}
     export { preset };`
  );
  assertFailure(
    "prototype-sensitive shorthand",
    "unsupported static object key __proto__",
    `const __proto__ = ${v5PresetFixture};
     export const preset = { __proto__ };`
  );
  assertFailure(
    "relative CommonJS preset re-export",
    unresolved,
    `const payload = require("./payload.js");
     exports.preset = payload.preset;`
  );
  assertFailure(
    "module exports preset",
    unsupported,
    `module.exports = { preset: ${v5PresetFixture} };`
  );
  assertFailure(
    "define property preset export",
    unsupported,
    `Object.defineProperty(exports, "preset", { get: () => ${v5PresetFixture} });`
  );
  assertFailure("star re-export", unsupported, `export * from "./payload.js";`);
  assertFailure(
    "default object preset export",
    unsupported,
    `export const validPreset = ${v5PresetFixture};
     export default { preset: ${v5PresetFixture} };`
  );
  assertFailure(
    "parenthesized default object preset export",
    unsupported,
    `export const validPreset = ${v5PresetFixture};
     export default ({ preset: ${v5PresetFixture} });`
  );
  assertFailure(
    "namespace preset re-export",
    unsupported,
    `export const validPreset = ${v5PresetFixture};
     export * as preset from "./payload.js";`
  );
  assertFailure(
    "imported namespace preset export",
    unsupported,
    `import * as payload from "./payload.js";
     export const validPreset = ${v5PresetFixture};
     export { payload as preset };`
  );
  for (const wrapper of [
    "(preset as any)",
    "(preset satisfies object)",
    "preset!"
  ]) {
    assertFailure(
      `assertion-wrapped mutation: ${wrapper}`,
      unresolved,
      `const preset = ${v5PresetFixture};
       ${wrapper}.version = 4;
       export { preset };`
    );
  }
}
