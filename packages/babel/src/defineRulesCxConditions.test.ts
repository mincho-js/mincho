import { describe, expect, it } from "vitest";
import { defineRulesCxConditionsOptimizationMetadataKey } from "./defineRulesCxConditions.js";
import {
  babelTransform,
  createDefineRulesCxPermutationSource,
  createDefineRulesCxRuntimeClasses,
  createDefineRulesCxRuntimeRecipeValue,
  createInspectableDefineRulesRuntime,
  createJoiningCx,
  createLocalDefineRulesCxFallbackSource,
  createResolvedStaticCssEvalProvider,
  forEachBooleanPermutation,
  getDefineRulesCxConditionCalls,
  runDefineRulesCxModule,
  runLocalDefineRulesCxModule
} from "./testUtils/plugin.js";

describe("minchoBabelPlugin", () => {
  it("leaves output unchanged when defineRules cx optimization is inactive", () => {
    const source = `
        import { defineRules } from '@mincho-js/css';

        const rules = defineRules({
          active: { color: "red" },
          idle: { color: "blue" }
        });

        export function button(active: boolean) {
          return rules.cx(rules.css("idle"), active && rules.css("active"));
        }
      `;

    const omitted = babelTransform(source);
    const emptyOptimize = babelTransform(source, { optimize: {} });
    const disabledOptimize = babelTransform(source, {
      optimize: { defineRulesCxConditions: false }
    });

    expect(emptyOptimize.result).toEqual(omitted.result);
    expect(emptyOptimize.code).toBe(omitted.code);
    expect(
      emptyOptimize.metadata[defineRulesCxConditionsOptimizationMetadataKey]
    ).toBeUndefined();
    expect(disabledOptimize.result).toEqual(omitted.result);
    expect(disabledOptimize.code).toBe(omitted.code);
    expect(
      disabledOptimize.metadata[defineRulesCxConditionsOptimizationMetadataKey]
    ).toBeUndefined();
  });

  it("accepts defineRules cx optimization independently from jsx css prop", () => {
    const source = `
        import { defineRules } from '@mincho-js/css';

        const rules = defineRules({
          active: { color: "red" },
          idle: { color: "blue" }
        });

        export function button(active: boolean) {
          return rules.cx(rules.css("idle"), active && rules.css("active"));
        }
      `;

    const disabled = babelTransform(source, { jsxCssProp: false });
    const enabled = babelTransform(source, {
      jsxCssProp: false,
      optimize: { defineRulesCxConditions: true }
    });

    expect(enabled.result).toEqual(disabled.result);
    expect(enabled.code).toBe(disabled.code);
    expect(
      disabled.metadata[defineRulesCxConditionsOptimizationMetadataKey]
    ).toBeUndefined();
    expect(
      enabled.metadata[defineRulesCxConditionsOptimizationMetadataKey]
    ).toBe(true);
  });

  it("marks and precomputes safe in-file defineRules cx condition operands", () => {
    const source = `
        import { defineRules } from '@mincho-js/css';

        const { css, cx } = defineRules({
          properties: { color: true }
        });
        const base = css({ color: "blue" });
        const activeClass = css({ color: "red" });

        export function button(active: boolean, danger: boolean) {
          return cx(base, active && activeClass, [danger ? activeClass : base]);
        }
      `;

    const disabled = babelTransform(source, {
      optimize: { defineRulesCxConditions: false }
    });

    const enabled = babelTransform(source, {
      optimize: { defineRulesCxConditions: true }
    });

    expect(enabled.result).toEqual(disabled.result);
    expect(disabled.code).toContain("return cx(");
    expect(enabled.code).toContain("const _minchoDefineRulesCx = [");
    expect(enabled.code).toContain("return _minchoDefineRulesCx[");
    expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
      {
        callee: "local-defineRules",
        operandCount: 3,
        conditionCount: 2,
        classOperandCount: 4,
        operands: [
          { kind: "class", source: "local-css-call" },
          {
            kind: "condition",
            operator: "&&",
            classOperand: { kind: "class", source: "local-css-call" }
          },
          {
            kind: "array",
            operands: [
              {
                kind: "ternary",
                consequent: { kind: "class", source: "local-css-call" },
                alternate: { kind: "class", source: "local-css-call" }
              }
            ]
          }
        ]
      }
    ]);
  });

  it("marks and precomputes provider-backed serialized defineRules cx calls and marker operands", () => {
    const source = `
        import { cx, base, activeClass } from "./styles";

        export function button(active: boolean) {
          return cx(base, active ? activeClass : base);
        }
      `;

    const disabled = babelTransform(source, {
      staticCssEvalProvider: createResolvedStaticCssEvalProvider({
        cx: createDefineRulesCxRuntimeRecipeValue(),
        base: "__mincho_seg_base base",
        activeClass: "__mincho_seg_active active"
      }),
      optimize: { defineRulesCxConditions: false }
    });

    const enabled = babelTransform(source, {
      staticCssEvalProvider: createResolvedStaticCssEvalProvider({
        cx: createDefineRulesCxRuntimeRecipeValue(),
        base: "__mincho_seg_base base",
        activeClass: "__mincho_seg_active active"
      }),
      optimize: { defineRulesCxConditions: true }
    });

    expect(enabled.result).toEqual(disabled.result);
    expect(disabled.code).toContain("return cx(");
    expect(enabled.code).toContain("const _minchoDefineRulesCx = [");
    expect(enabled.code).toContain("return _minchoDefineRulesCx[");
    expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
      {
        callee: "provider-createDefineRulesCxRuntime",
        operandCount: 2,
        conditionCount: 1,
        classOperandCount: 3,
        operands: [
          { kind: "class", source: "provider-marker" },
          {
            kind: "ternary",
            consequent: { kind: "class", source: "provider-marker" },
            alternate: { kind: "class", source: "provider-marker" }
          }
        ]
      }
    ]);
  });

  it("bails out unchanged for unsupported defineRules cx condition shapes", () => {
    const unsupportedReturns = [
      "return cx(base || activeClass);",
      "return cx(...classes);",
      "return cx({ [base]: active });",
      "return cx((active || activeClass) && base);",
      "return cx(active.valueOf?.() && base);",
      "return cx(String.raw`active` && base);"
    ];

    for (const returnStatement of unsupportedReturns) {
      const source = `
          import { defineRules } from '@mincho-js/css';

          const { css, cx } = defineRules({
            properties: { color: true }
          });
          const base = css({ color: "blue" });
          const activeClass = css({ color: "red" });
          const classes = [base, activeClass];

          export function button(active: boolean) {
            ${returnStatement}
          }
        `;

      const disabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: false }
      });

      const enabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: true }
      });

      expect(enabled.result).toEqual(disabled.result);
      expect(enabled.code).toBe(disabled.code);
      expect(getDefineRulesCxConditionCalls(enabled.metadata)).toEqual([]);
      expect(enabled.metadata.minchoStaticCssEval?.diagnostics ?? []).toEqual(
        []
      );
    }
  });

  it("leaves provider-backed external class operands on the runtime path", () => {
    const source = `
        import { cx, base, externalClass } from "./styles";

        export function button(active: boolean) {
          return cx(base, active && externalClass);
        }
      `;

    const staticCssEvalProvider = createResolvedStaticCssEvalProvider({
      cx: createDefineRulesCxRuntimeRecipeValue(),
      base: "__mincho_seg_base base",
      externalClass: "external-class"
    });

    const disabled = babelTransform(source, {
      staticCssEvalProvider,
      optimize: { defineRulesCxConditions: false }
    });

    const enabled = babelTransform(source, {
      staticCssEvalProvider,
      optimize: { defineRulesCxConditions: true }
    });

    expect(enabled.code).toBe(disabled.code);
    expect(getDefineRulesCxConditionCalls(enabled.metadata)).toEqual([]);
  });

  it("bails out without evaluating inactive function-call class operands", () => {
    const source = `
        import { defineRules } from '@mincho-js/css';

        const { cx } = defineRules({
          properties: { color: true }
        });

        function makeClass(): string {
          throw new Error("inactive branch evaluated");
        }

        export function button(active: boolean) {
          return cx(active && makeClass());
        }
      `;

    const disabled = babelTransform(source, {
      optimize: { defineRulesCxConditions: false }
    });

    const enabled = babelTransform(source, {
      optimize: { defineRulesCxConditions: true }
    });

    expect(enabled.result).toEqual(disabled.result);
    expect(enabled.code).toBe(disabled.code);
    expect(enabled.code).toContain("active && makeClass()");
    expect(getDefineRulesCxConditionCalls(enabled.metadata)).toEqual([]);
    expect(enabled.metadata.minchoStaticCssEval?.diagnostics ?? []).toEqual([]);
  });

  it("precomputes 1-4 condition defineRules cx tables that match runtime cx", () => {
    for (let conditionCount = 1; conditionCount <= 4; conditionCount += 1) {
      const source = createDefineRulesCxPermutationSource(conditionCount);
      const staticCssEvalProvider = createResolvedStaticCssEvalProvider({
        cx: createDefineRulesCxRuntimeRecipeValue(),
        ...createDefineRulesCxRuntimeClasses(conditionCount)
      });

      const disabled = babelTransform(source, {
        staticCssEvalProvider,
        optimize: { defineRulesCxConditions: false }
      });

      const enabled = babelTransform(source, {
        staticCssEvalProvider,
        optimize: { defineRulesCxConditions: true }
      });

      const classes = createDefineRulesCxRuntimeClasses(conditionCount);
      let optimizedCxCalls = 0;
      const optimizedButton = runDefineRulesCxModule(
        enabled.code,
        classes,
        createJoiningCx(() => {
          optimizedCxCalls += 1;
        })
      );

      const optimizedCxCallsAfterInit = optimizedCxCalls;
      const referenceButton = runDefineRulesCxModule(
        disabled.code,
        classes,
        createJoiningCx()
      );

      expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
        { conditionCount }
      ]);
      expect(enabled.code).toContain("const _minchoDefineRulesCx = [");
      expect(enabled.code).toContain("return _minchoDefineRulesCx[");
      expect(enabled.code).not.toContain("return cx(");
      expect(optimizedCxCallsAfterInit).toBe(1 << conditionCount);

      forEachBooleanPermutation(conditionCount, (flags) => {
        expect(optimizedButton(...flags)).toBe(referenceButton(...flags));
      });

      expect(optimizedCxCalls).toBe(optimizedCxCallsAfterInit);
    }
  });

  it("preserves condition evaluation count and order for optimized tables", () => {
    const source = `
        import { cx, base, class0, class1 } from "./styles";

        export function button(probe: { first: boolean; second: boolean }) {
          return cx(base, probe.first && class0, probe.second && class1);
        }
      `;

    const staticCssEvalProvider = createResolvedStaticCssEvalProvider({
      cx: createDefineRulesCxRuntimeRecipeValue(),
      base: "__mincho_seg_base base",
      class0: "__mincho_seg_class_0 class-0",
      class1: "__mincho_seg_class_1 class-1"
    });

    const enabled = babelTransform(source, {
      staticCssEvalProvider,
      optimize: { defineRulesCxConditions: true }
    });

    const events: string[] = [];
    let optimizedCxCalls = 0;
    const button = runDefineRulesCxModule(
      enabled.code,
      createDefineRulesCxRuntimeClasses(2),
      createJoiningCx(() => {
        optimizedCxCalls += 1;
      })
    );

    const optimizedCxCallsAfterInit = optimizedCxCalls;
    const probe = {
      get first() {
        events.push("first");

        return true;
      },

      get second() {
        events.push("second");

        return false;
      }
    };

    expect(button(probe)).toBe(
      "__mincho_seg_base base __mincho_seg_class_0 class-0"
    );
    expect(events).toEqual(["first", "second"]);
    expect(optimizedCxCalls).toBe(optimizedCxCallsAfterInit);
  });

  it("leaves more than 4 defineRules cx conditions on the runtime path", () => {
    const source = createDefineRulesCxPermutationSource(5);
    const staticCssEvalProvider = createResolvedStaticCssEvalProvider({
      cx: createDefineRulesCxRuntimeRecipeValue(),
      ...createDefineRulesCxRuntimeClasses(5)
    });

    const disabled = babelTransform(source, {
      staticCssEvalProvider,
      optimize: { defineRulesCxConditions: false }
    });

    const enabled = babelTransform(source, {
      staticCssEvalProvider,
      optimize: { defineRulesCxConditions: true }
    });

    expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
      { conditionCount: 5 }
    ]);
    expect(enabled.code).toBe(disabled.code);
    expect(enabled.code).toContain("return cx(");
    expect(enabled.code).not.toContain("_minchoDefineRulesCx");
  });

  it("folds 5+ local defineRules cx conflicts with fallback chains", () => {
    const conditionCount = 5;
    const source = createLocalDefineRulesCxFallbackSource(conditionCount);
    const disabled = babelTransform(source, {
      optimize: { defineRulesCxConditions: false }
    });

    const enabled = babelTransform(source, {
      optimize: { defineRulesCxConditions: true }
    });

    const referenceRuntime = createInspectableDefineRulesRuntime();
    const optimizedRuntime = createInspectableDefineRulesRuntime();
    const referenceButton = runLocalDefineRulesCxModule(
      disabled.code,
      referenceRuntime.defineRules
    );

    const optimizedButton = runLocalDefineRulesCxModule(
      enabled.code,
      optimizedRuntime.defineRules
    );

    const cssCallCount = enabled.code.match(/css\(\{/g)?.length ?? 0;

    expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
      { conditionCount }
    ]);
    expect(disabled.code).toContain("return cx(");
    expect(enabled.code).not.toContain("const _minchoDefineRulesCx = [");
    expect(enabled.code).not.toContain("return cx(");
    expect(enabled.code).toContain('.filter(Boolean).join(" ")');
    expect(cssCallCount).toBeLessThanOrEqual(conditionCount * 2 + 2);

    forEachBooleanPermutation(conditionCount, (flags) => {
      expect(
        optimizedRuntime.computeClassNameStyle(optimizedButton(...flags)),
        `flags: ${flags.join(",")}`
      ).toEqual(
        referenceRuntime.computeClassNameStyle(referenceButton(...flags))
      );
    });
  });

  it("bails out fallback chains for explicit shorthand conflicts", () => {
    const propertyPairs = [
      ["all", "color"],
      ["inset", "top"],
      ["placeItems", "alignItems"],
      ["font", "fontFamily"],
      ["border", "borderTopColor"]
    ] as const;

    for (const [shorthand, longhand] of propertyPairs) {
      const source = `
          import { defineRules } from "@mincho-js/css";

          const { css, cx } = defineRules({
            properties: { ${shorthand}: true, ${longhand}: true }
          });
          const base = css({ ${shorthand}: "initial", ${longhand}: "initial" });

          export function button(
            flag0: boolean,
            flag1: boolean,
            flag2: boolean,
            flag3: boolean,
            flag4: boolean
          ) {
            return cx(base, ${Array.from(
              { length: 5 },
              (_, index) => `flag${index} && base`
            ).join(", ")});
          }
        `;

      const disabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: false }
      });

      const enabled = babelTransform(source, {
        optimize: { defineRulesCxConditions: true }
      });

      expect(enabled.code).toBe(disabled.code);
    }
  });

  it("bails out fallback chains for missing-declaration branches", () => {
    const source = `
        import { defineRules } from "@mincho-js/css";

        const { css, cx } = defineRules({
          properties: { color: true }
        });
        const color0 = css({ color: "red" });
        const color1 = css({ color: "blue" });
        const color2 = css({ color: "green" });
        const color3 = css({ color: "purple" });
        const color4 = css({ color: "orange" });

        export function button(
          flag0: boolean,
          flag1: boolean,
          flag2: boolean,
          flag3: boolean,
          flag4: boolean
        ) {
          return cx(
            flag0 && color0,
            flag1 && color1,
            flag2 && color2,
            flag3 && color3,
            flag4 && color4
          );
        }
      `;

    const disabled = babelTransform(source, {
      optimize: { defineRulesCxConditions: false }
    });

    const enabled = babelTransform(source, {
      optimize: { defineRulesCxConditions: true }
    });

    expect(getDefineRulesCxConditionCalls(enabled.metadata)).toMatchObject([
      { conditionCount: 5 }
    ]);
    expect(enabled.code).toBe(disabled.code);
    expect(enabled.code).toContain("return cx(");
    expect(enabled.code).not.toContain("_minchoDefineRulesCx");
  });
});
