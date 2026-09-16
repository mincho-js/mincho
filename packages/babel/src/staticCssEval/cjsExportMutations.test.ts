import { describe, expect, it } from "vitest";
import { createImportedStaticCssEvalProvider } from "./importedModules.js";

function resolveButton(source: string) {
  const importerId = "/project/entry.cjs";
  const resolvedId = "/project/styles.cjs";
  const provider = createImportedStaticCssEvalProvider({
    modules: [
      { id: importerId, source: 'const styles = require("./styles.cjs");' },
      { id: resolvedId, source }
    ],
    importResolutions: [
      {
        importerId,
        importPath: "./styles.cjs",
        resolvedId,
        resolutionMode: "require"
      }
    ]
  });

  return provider.getResolvedCssValue({
    importerId,
    expressionStart: 0,
    expressionEnd: 6,
    bindingName: "styles",
    memberPath: ["button"]
  });
}

describe("CommonJS export mutation safety", () => {
  it.each([
    'exports.button = { color: "red" }; exports[key] = { color: "blue" };',
    'exports.button = { color: "red" }; Object.defineProperty(exports, key, { value: { color: "blue" } });',
    'exports.button = { color: "red" }; if (enabled) module.exports = other;',
    'module.exports = { button: { color: "red" }, ...other };',
    'exports.button = { color: "red" }; delete exports.button;',
    'exports.button = { color: "red" }; exports.button++;',
    'exports.button = { color: "red" }; ({ button: exports.button } = other);',
    'exports.button = { color: "red" }; for (exports.button of values) {}',
    'exports.button = { color: "red" }; exports.other = exports.button++;',
    'exports.button = { color: "red" }; exports.other = { nested: delete exports.button };',
    'exports = {}; exports.button = { color: "red" };',
    'exports.button = { color: "red" }; exports = {}; exports.button = { color: "blue" };',
    'exports.button = { selectors: { "&:hover": { color: "red" } } }; exports.button.selectors["&:hover"].color = "blue";'
  ])("does not resolve stale exports after mutation: %s", (source) => {
    expect(resolveButton(source)).toMatchObject({
      kind: "error",
      diagnostic: { id: "STATIC_CSS_EVAL_CJS_EXPORT_UNSUPPORTED" }
    });
  });

  it("keeps statically known exports when a different named export changes", () => {
    expect(
      resolveButton('exports.button = { color: "red" }; exports.other++;')
    ).toMatchObject({ kind: "resolved", value: { color: "red" } });
  });
});
