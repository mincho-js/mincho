import { describe, expect, it } from "vitest";
import { createCompiledDefineRulesCxRuntime } from "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
import { babelTransform } from "../testUtils/plugin.js";

const source = `import {createCompiledDefineRulesCxRuntime as make} from "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
const cx = make({classWrites:[["red",0],["blue",0]]});
export const result = cx("red","blue");`;

describe("standalone scoped cx", () => {
  it("folds a local immutable compiled factory independently of runtimeCodegen", () => {
    const result = babelTransform(source, {
      optimize: { staticScopedCx: true, runtimeCodegen: false }
    });

    expect(result.code).toContain('result = "blue"');
    expect(result.code).not.toContain("make(");
    expect(result.code).not.toContain("createCompiledDefineRulesCxRuntime");
    expect(result.metadata.minchoClassStringBudget).toEqual({
      entries: 255,
      units: 4092
    });
  });

  it("does not execute external providers or mutate default output", () => {
    const input =
      'import {cx} from "./unavailable"; export const result = cx("red");';

    expect(
      babelTransform(input, { optimize: { staticScopedCx: true } }).code
    ).toBe(babelTransform(input).code);
    expect(babelTransform(source).code).toContain('cx("red", "blue")');
  });

  it.each([
    'try { result = cx("red", "blue"); } catch { result = "fallback"; } const cx = make({classWrites:[["red",0],["blue",0]]});',
    'try { result = cx("red", "blue"); } catch { result = "fallback"; } var cx = make({classWrites:[["red",0],["blue",0]]});',
    'try { result = run(); } catch { result = "fallback"; } const cx = make({classWrites:[["red",0],["blue",0]]}); function run() { return cx("red", "blue"); }',
    'if (false) { var cx = make({classWrites:[["red",0],["blue",0]]}); } try { result = cx("red", "blue"); } catch { result = "fallback"; }',
    'const cx = make({classWrites:[["red",0],["blue",0]]}); try { result = run(); } catch { result = "fallback"; } const red = "red"; function run() { return cx(red, "blue"); }',
    'const cx = make({classWrites:[["red",0],["blue",0]]}); try { result = alias("red", "blue"); } catch { result = "fallback"; } const alias = cx;',
    'try { const cx = alias({classWrites:[["red",0],["blue",0]]}); result = cx("red", "blue"); } catch { result = "fallback"; } const alias = make;',
    'const cx = make({classWrites:[["red",0],["blue",0]]}); result = cx("red", "blue"); try { const unused = alias({classWrites:[["red",0]]}); } catch { result = "fallback"; } const alias = make;'
  ])(
    "preserves initialization errors and caught fallback values: %s",
    (body) => {
      const input = `import {createCompiledDefineRulesCxRuntime as make} from "@mincho-js/css/defineRules/createDefineRulesCxRuntime"; let result; ${body}`;

      for (const staticScopedCx of [false, true]) {
        const output = babelTransform(input, {
          optimize: { staticScopedCx, runtimeCodegen: false }
        }).code;

        const execute = new Function(
          "make",
          output.replace(/import[^;]+;|export\s*\{\s*\};?/g, "") +
            "\nreturn result;"
        );

        expect(execute(createCompiledDefineRulesCxRuntime)).toBe("fallback");
      }
    }
  );

  it("still folds initialized aliases and function-local factories", () => {
    const input = `import {createCompiledDefineRulesCxRuntime as make} from "@mincho-js/css/defineRules/createDefineRulesCxRuntime";
export function render() {
  const cx = make({classWrites:[["red",0],["blue",0]]});
  const alias = cx;
  return alias("red", "blue");
}`;

    const output = babelTransform(input, {
      optimize: { staticScopedCx: true, runtimeCodegen: false }
    }).code;

    expect(output).toContain('return "blue"');
    expect(output).not.toContain('alias("red"');
  });
});
