import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it
} from "vitest";
import type { Adapter } from "@vanilla-extract/css";
import {
  mockAdapter,
  removeAdapter,
  setAdapter
} from "@vanilla-extract/css/adapter";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { defineRules } from "./index.js";
import { rules as rootRules } from "../rules/index.js";
import { getDefineRulesDefinition } from "./extension.js";
import { getRulesConfig } from "../rules/metadata.js";
import { createDefineRulesRulesRuntime } from "./createDefineRulesRulesRuntime.js";

const emitted: Parameters<Adapter["appendCss"]>[0][] = [];
beforeEach(() => {
  emitted.length = 0;
  setAdapter({ ...mockAdapter, appendCss: (rule) => emitted.push(rule) });
  setFileScope("scoped-rules.css.ts", "@test/scoped-rules");
});
afterEach(() => {
  endFileScope();
  removeAdapter();
});

function definitions() {
  return defineRules({
    properties: {
      color: { brand: "navy", muted: "gray" },
      paddingLeft: { small: 4, large: 16 },
      paddingRight: { small: 4, large: 16 },
      opacity: [0.5, 1]
    },
    shortcuts: { px: ["paddingLeft", "paddingRight"] },
    conditions: { hov: { selector: "&:hover" } },
    context: { tone: "brand" as const }
  });
}

describe("defineRules().rules", () => {
  it("resolves tokens, shortcuts and conditions in base, variants and compounds", () => {
    const { rules } = definitions();
    const recipe = rules({
      color: "muted",
      base: (context) => ({ color: context.tone, px: "small" }),
      props: ["width"],
      variants: {
        size: { small: { px: "small" }, large: { _hov: { px: "large" } } },
        active: { true: { opacity: 1 }, false: { opacity: 0.5 } }
      },
      defaultVariants: { active: true, size: "small" },
      compoundVariants: ({ active, size }) => [
        {
          condition: [active.false, size.large],
          style: { _hov: { color: "brand" } }
        }
      ]
    });
    const config = getRulesConfig(recipe);
    expect(recipe()).toBe(
      [
        config.defaultClassName,
        config.variantClassNames.size.small,
        config.variantClassNames.active.true
      ].join(" ")
    );
    expect(recipe({ active: false, size: "large" })).toBe(
      [
        config.defaultClassName,
        config.variantClassNames.size.large,
        config.variantClassNames.active.false,
        config.compoundVariants[0][1]
      ].join(" ")
    );
    expect(recipe.props({ width: "12px" })).toEqual({
      [config.propVars.width]: "12px"
    });
    expect(
      emitted
        .filter((entry) => entry.type === "local")
        .map((entry) => entry.rule)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          color: "navy",
          paddingLeft: 4,
          paddingRight: 4
        }),
        { selectors: { "&:hover": { paddingLeft: 16, paddingRight: 16 } } },
        { selectors: { "&:hover": { color: "navy" } } }
      ])
    );
    expectTypeOf<Parameters<typeof recipe>[0]>().toMatchTypeOf<
      { active?: boolean; size?: "small" | "large" } | unknown[] | undefined
    >();
    const invalidInputs = () => {
      // @ts-expect-error Only declared token values are accepted in base styles.
      rules({ base: { color: "missing" } });
      // @ts-expect-error Variant styles use the same scoped property values.
      rules({ variants: { tone: { bad: { px: "missing" } } } });
      rules({
        variants: { size: { small: { px: "small" } } },
        // @ts-expect-error Default selections must name an existing variant value.
        defaultVariants: { size: "large" }
      });
      // @ts-expect-error Boolean variants accept booleans, not their string spellings.
      recipe({ active: "true" });
      // @ts-expect-error Properties outside this authoring definition are rejected.
      rules({ margin: 4 });
      // @ts-expect-error Extra properties are rejected even beside a known key.
      rules({ color: "brand", typo: 1 });
      // @ts-expect-error Nested base styles keep excess-property checking.
      rules({ base: { color: "brand", typo: 1 } });
    };
    void invalidInputs;
  });

  it("normalizes raw recipes for standard rules while preserving composed class strings", () => {
    const { rules } = definitions();
    const input = {
      base: ["external", { px: "small" }],
      variants: { active: { true: "external-active" } },
      defaultVariants: { active: true }
    } as const;
    const options = rules.raw({ ...input, base: [...input.base] });
    expect(options.base).toEqual([
      "external",
      { paddingLeft: 4, paddingRight: 4 }
    ]);
    const result = rootRules(options);
    expect(result().split(" ")).toEqual(
      expect.arrayContaining(["external", "external-active"])
    );
    expect(input.base[1]).toEqual({ px: "small" });
  });

  it("extends recipes with inherited selections and the child definition's tokens", () => {
    const parent = definitions();
    const base = parent.rules({
      variants: { size: { small: { px: "small" } } },
      props: ["width"],
      defaultVariants: { size: "small" }
    });
    const child = defineRules.extends(parent, {
      properties: { color: { brand: "indigo" } }
    });
    const extended = child.rules.extends(base, {
      base: { color: "brand" },
      variants: { active: { true: { opacity: 1 } } },
      compoundVariants: ({ size, active }) => [
        {
          condition: [size.small, active.true],
          style: { px: "large" }
        }
      ]
    });
    expect(extended({ active: true }).split(" ")).toEqual(
      expect.arrayContaining(base().split(" "))
    );
    expect(extended.props({ width: 24 })).toEqual(base.props({ width: 24 }));
    expect(child.rules.raw({ color: "brand" })).toMatchObject({
      color: "indigo"
    });
  });

  it("normalizes multiple recipes and reusable pattern factories through the same resolver", () => {
    const { rules } = definitions();
    const action: {
      variants?: { active: { true: { color: "brand" } } };
      props?: ["width"];
    } = {
      variants: { active: { true: { color: "brand" } } },
      props: ["width"]
    };
    const recipes = rules.multiple({
      card: { base: { px: "small" } },
      action
    });
    expect(recipes.action({ active: true }).split(" ")).toContain(
      recipes.action.classNames.variants.active.true
    );
    expect(recipes.action.props({ width: "20px" })).toEqual({
      [getRulesConfig(recipes.action).propVars.width]: "20px"
    });
    const padded = rules.with((style: { px: "small" | "large" }) => ({
      base: style,
      variants: { active: { true: { color: "brand" } } }
    }));
    expect(padded.raw({ px: "large" }).base).toEqual({
      paddingLeft: 16,
      paddingRight: 16
    });
    expect(
      padded.multiple({ compact: { px: "small" } }).compact({ active: true })
    ).toBeTypeOf("string");
    const invalidInputs = () => {
      // @ts-expect-error Reusable factories preserve fresh-object checks.
      padded({ px: "small", typo: 1 });
    };
    void invalidInputs;
    const child = padded.extends(recipes.action, { px: "large" });
    expect(child({ active: true }).split(" ")).toEqual(
      expect.arrayContaining(recipes.action({ active: true }).split(" "))
    );
  });

  it("reconstructs an exported authoring factory without changing the recipe runtime", () => {
    const owner = definitions();
    const _config = getDefineRulesDefinition(owner);
    const serializer = Reflect.get(owner.rules, "__recipe__") as {
      args: [typeof _config];
    };
    const restored = createDefineRulesRulesRuntime(
      JSON.parse(JSON.stringify(serializer.args[0])) as typeof _config
    );
    const recipe = restored({ base: { color: "brand" } });
    expect(Reflect.get(recipe, "__recipe__")).toMatchObject({
      importPath: "@mincho-js/css/rules/createRuntimeFn",
      importName: "createCompiledRuntimeFn"
    });
    expect(restored.raw({ base: { color: "brand" } })).toEqual(
      owner.rules.raw({ base: { color: "brand" } })
    );
  });

  it("preserves factory-only arguments without forwarding them to CSS", () => {
    const { rules } = defineRules({
      properties: { color: (value: string) => value.toUpperCase() }
    });
    const factory = rules.with(
      (style: { color: string; getColor: () => string }) => ({
        base: { color: style.getColor() },
        variants: { active: { true: { color: style.color } } }
      })
    );
    const args = { color: "red", getColor: () => "blue" };

    expect(factory(args)({ active: true })).toBeTypeOf("string");
    expect(factory.raw(args).base).toEqual({ color: "BLUE" });
    expect(
      factory.multiple({ first: args }).first({ active: true })
    ).toBeTypeOf("string");

    const parent = rules({ base: { color: "green" } });
    expect(factory.extends(parent, args)({ active: true }).split(" ")).toEqual(
      expect.arrayContaining(parent().split(" "))
    );

    const invalidInputs = () => {
      // @ts-expect-error Factory-only arguments retain their declared types.
      factory({ color: "red", getColor: () => 1 });
      // @ts-expect-error Fresh factory arguments still reject unknown fields.
      factory({ color: "red", getColor: () => "blue", typo: true });
    };
    void invalidInputs;
  });

  it("evaluates local function definitions before serializing recipes", () => {
    const { rules } = defineRules({
      properties: { padding: (value: number) => value * 4 }
    });
    const recipe = rules({ base: { padding: 2 } });
    expect(rules.raw({ base: { padding: 2 } }).base).toEqual({ padding: 8 });
    const serializedRecipe = Reflect.get(recipe, "__recipe__") as {
      args: unknown;
    };
    expect(() => JSON.stringify(serializedRecipe.args)).not.toThrow();
    const serializedFactory = Reflect.get(rules, "__recipe__") as {
      args: unknown;
    };
    expect(() => serializedFactory.args).toThrow("function-valued");
  });

  it("requires scalar resolver values throughout recipe styles", () => {
    const { rules } = defineRules({
      properties: { color: (value: string) => value.toUpperCase() },
      shortcuts: {
        text: "color",
        paint: (value: string) => ({ color: value.toUpperCase() })
      }
    });
    expect(rules.raw({ base: { color: { _hover: "red" } } }).base).toEqual({
      selectors: { "&:hover": { color: "RED" } }
    });
    expect(() => rules.raw({ base: { color: {} } } as never)).toThrow(
      TypeError
    );
    const parent = rules({ variants: { active: { true: { color: "red" } } } });
    type Input = Parameters<Parameters<typeof rules.with>[0]>[0];
    const reusable = rules.with((style: Input) => ({ base: style }));
    expect(reusable.raw({ color: { _hover: "red" } }).base).toEqual({
      selectors: { "&:hover": { color: "RED" } }
    });

    const validInputs = () => {
      const named = { color: "red", extra: 1 };
      const optional: { color?: string } = {};
      rules(named);
      rules({ base: named });
      reusable(named);
      reusable(optional);
      rules<undefined>({ base: { color: "red" } });
      rules.raw<undefined>({ base: { color: "red" } });
      rules.with<Input, undefined>((style) => ({ base: style }));
      rules.multiple<{ first: undefined }, Record<never, never>>({
        first: { base: { color: "red" } }
      });
      rules.extends<typeof parent.classNames.variants, never>(parent, {
        base: { color: "red" }
      });
      reusable.extends<typeof parent.classNames.variants, never>(parent, {
        color: "red"
      });
    };
    void validInputs;

    const invalidInputs = () => {
      // @ts-expect-error Scalar definitions preserve fresh-object checks.
      rules({ color: "red", typo: 1 });
      // @ts-expect-error Scalar base styles preserve fresh-object checks.
      rules({ base: { color: "red", typo: 1 } });
      // @ts-expect-error Scalar reusable factories preserve fresh-object checks.
      reusable({ color: "red", typo: 1 });
      // @ts-expect-error Multiple patterns preserve nested fresh-object checks.
      rules.multiple({ bad: { base: { color: "red", typo: 1 } } });
      // @ts-expect-error Recipe top-level styles cannot pass {} to a scalar resolver.
      rules({ color: {} });
      // @ts-expect-error Recipe base styles retain the scalar resolver input.
      rules({ base: { color: {} } });
      // @ts-expect-error Raw recipe styles use the same scalar input requirement.
      rules.raw({ base: { text: {} } });
      // @ts-expect-error Variant styles cannot pass {} to functional shortcuts.
      rules({ variants: { tone: { normal: { paint: {} } } } });
      // @ts-expect-error Style arrays retain scalar resolver requirements.
      rules({ base: ["external", { text: {} }] });
      // @ts-expect-error Context callback return values retain scalar requirements.
      rules({ base: () => ({ color: {} }) });
      // @ts-expect-error Nested conditions retain scalar resolver requirements.
      rules({ base: { color: { _hover: {} } } });
      // @ts-expect-error Compound styles cannot pass {} to scalar resolvers.
      rules({
        variants: { active: { true: {} } },
        compoundVariants: ({ active }) => [
          { condition: [active.true], style: { color: {} } }
        ]
      });
      // @ts-expect-error Multiple recipes validate each pattern independently.
      rules.multiple({ good: { color: "red" }, bad: { base: { color: {} } } });
      // @ts-expect-error Extended recipes use the child's input contract.
      rules.extends(parent, { base: { color: {} } });
      // @ts-expect-error Reusable factories cannot return an invalid scalar style.
      rules.with((style: { color: string }) => ({
        base: [style, { paint: {} }]
      }));
      // @ts-expect-error Reusable factory arguments retain the input contract.
      reusable({ color: {} });
      // @ts-expect-error Raw reusable factory arguments retain the contract.
      reusable.raw({ color: {} });
      // @ts-expect-error Multiple reusable factory arguments retain the contract.
      reusable.multiple({ bad: { color: {} } });
      // @ts-expect-error Extended reusable factory arguments retain the contract.
      reusable.extends(parent, { color: {} });
      const optional: {
        variants?: { active: { true: { color: Record<never, never> } } };
      } = {};
      // @ts-expect-error Optional variant groups are checked when present.
      rules(optional);
    };
    void invalidInputs;
  });

  it("preserves object resolver arguments and contextual recipe inference", () => {
    const { rules } = defineRules({
      properties: {
        color: (value: string) => value.toUpperCase(),
        opacity: ({ value = 1 }: { value?: number }) => value
      },
      shortcuts: { alpha: "opacity" },
      context: { color: "red" }
    });
    const activeStyle = (context: { readonly color: "red" }) => ({
      color: context.color,
      alpha: {}
    });
    const recipe = rules({
      base: (context) => {
        expectTypeOf(context).toEqualTypeOf<{ readonly color: "red" }>();
        return [{ color: context.color }, { opacity: {} }];
      },
      variants: {
        active: {
          true: activeStyle,
          false: { opacity: { _hover: {} } }
        }
      },
      defaultVariants: { active: true },
      compoundVariants: ({ active }) => [
        { condition: [active.true], style: { opacity: {} } }
      ]
    });
    expect(recipe({ active: true })).toBeTypeOf("string");
    expect(rules.raw({ base: { opacity: {}, alpha: {} } }).base).toEqual({
      opacity: 1
    });
    const options: {
      variants?: { size: { small: { color: string } } };
      props?: ["width"];
    } = {
      variants: { size: { small: { color: "red" } } },
      props: ["width"]
    };
    const multiple = rules.multiple({ empty: {}, sized: options });
    expect(multiple.sized({ size: "small" })).toBeTypeOf("string");
    expect(multiple.sized.props({ width: 12 })).toEqual({
      [getRulesConfig(multiple.sized).propVars.width]: 12
    });
  });
});
