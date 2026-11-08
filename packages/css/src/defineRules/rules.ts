import type { CSSRule } from "@mincho-js/transform-to-vanilla";
import { rules as rootRules } from "../rules/index.js";
import { mapValues } from "../rules/utils.js";
import type {
  BrandValue,
  ComplexPropDefinitions,
  ExtendedProps,
  ExtendedVariants,
  PatternOptions,
  PropTarget,
  RecipeStyleRule,
  RuntimeFn,
  VariantGroups,
  VariantSelection,
  VariantStringMap
} from "../rules/types.js";

type ScopedStyle<Input, Context> =
  | Input
  | string
  | Array<Input | string>
  | ((context: Context) => Input | Array<Input>);
type ScopedVariants<Input, Context> = Record<
  string,
  Record<string, ScopedStyle<Input, Context>>
>;
// Infer group/value names while keeping style leaves concrete for completion
// and contextual callback parameters.
type ContextualVariants<Input, Context, Variants> = {
  [Group in keyof Variants]: {
    [Value in keyof Variants[Group]]: ScopedStyle<Input, Context>;
  };
};
type ResolvedVariants<Variants> = [Variants] extends [undefined]
  ? Record<never, never>
  : {
      [Group in keyof Variants]: {
        [Value in keyof Variants[Group]]: RecipeStyleRule;
      };
    };
type PropsDefinition = ComplexPropDefinitions<PropTarget> | undefined;
type PatternProps<Props, Key extends PropertyKey> = Key extends keyof Props
  ? Extract<Props[Key], PropsDefinition>
  : never;

export type DefineRulesPatternOptions<
  Input,
  Context,
  Variants,
  Props extends PropsDefinition,
  Selection extends VariantGroups = ResolvedVariants<
    Exclude<Variants, undefined>
  >
> = Input & {
  // The definition already fixes style types. Do not infer them back from a
  // with() callback's return value (which can expand CSS conditional unions).
  base?: NoInfer<ScopedStyle<Input, Context>>;
  variants?: Variants &
    ContextualVariants<Input, Context, Variants> &
    ScopedVariants<Input, Context>;
  props?: Props;
  defaultVariants?: VariantSelection<Selection>;
  compoundVariants?: (variants: VariantStringMap<Selection>) => Array<{
    condition: Array<BrandValue<Selection>>;
    style: ScopedStyle<Input, Context>;
  }>;
};

type ScopedResult<Variants, Props extends PropsDefinition> = RuntimeFn<
  ResolvedVariants<Exclude<Variants, undefined>>,
  Exclude<Props, undefined>
>;

interface ScopedRulesWith<Style, Variants, Props extends PropsDefinition> {
  (style: Style, debugId?: string): ScopedResult<Variants, Props>;
  raw(
    style: Style
  ): PatternOptions<ResolvedVariants<Exclude<Variants, undefined>>, Props>;
  multiple<Styles extends Record<string | number, Style>>(
    styles: Styles,
    debugId?: string
  ): { [Key in keyof Styles]: ScopedResult<Variants, Props> };
  extends<
    ParentVariants extends VariantGroups,
    ParentProps extends ComplexPropDefinitions<PropTarget | undefined>
  >(
    parent: RuntimeFn<ParentVariants, ParentProps>,
    style: Style,
    debugId?: string
  ): RuntimeFn<
    ExtendedVariants<
      ParentVariants,
      ResolvedVariants<Exclude<Variants, undefined>>
    >,
    ExtendedProps<ParentProps, Props>
  >;
}

export interface DefineRulesRules<Input, Context = undefined> {
  // Declared variants must infer even when every style is a context callback.
  // Separate optional overloads keep recipes without variants from widening.
  <
    Variants extends ScopedVariants<Input, Context>,
    Props extends PropsDefinition = undefined
  >(
    options: DefineRulesPatternOptions<Input, Context, Variants, Props> & {
      variants: Variants;
    },
    debugId?: string
  ): ScopedResult<Variants, Props>;

  <
    Variants extends ScopedVariants<Input, Context> | undefined = undefined,
    Props extends PropsDefinition = undefined
  >(
    options: DefineRulesPatternOptions<Input, Context, Variants, Props>,
    debugId?: string
  ): ScopedResult<Variants, Props>;

  raw<
    Variants extends ScopedVariants<Input, Context>,
    Props extends PropsDefinition = undefined
  >(
    options: DefineRulesPatternOptions<Input, Context, Variants, Props> & {
      variants: Variants;
    }
  ): PatternOptions<ResolvedVariants<Exclude<Variants, undefined>>, Props>;

  raw<
    Variants extends ScopedVariants<Input, Context> | undefined = undefined,
    Props extends PropsDefinition = undefined
  >(
    options: DefineRulesPatternOptions<Input, Context, Variants, Props>
  ): PatternOptions<ResolvedVariants<Exclude<Variants, undefined>>, Props>;

  // Independent maps keep missing/optional fields in one recipe from widening
  // the inferred variants and runtime props of its siblings.
  multiple<
    Variants extends Record<string | number, unknown>,
    Props extends Record<string | number, unknown>
  >(
    patterns: {
      [Key in keyof Variants]: DefineRulesPatternOptions<
        Input,
        Context,
        Variants[Key],
        PatternProps<Props, Key>
      >;
    } & {
      [Key in keyof Props]: { props?: Props[Key] & PropsDefinition };
    },
    debugId?: string
  ): {
    [Key in keyof Variants]: ScopedResult<
      Variants[Key],
      PatternProps<Props, Key>
    >;
  };

  with<
    Style extends Input,
    Variants extends ScopedVariants<Input, Context>,
    Props extends PropsDefinition = undefined
  >(
    callback: (style: Style) => DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props
    > & {
      variants: Variants;
    }
  ): ScopedRulesWith<Style, Variants, Props>;

  with<
    Style extends Input,
    Variants extends ScopedVariants<Input, Context> | undefined = undefined,
    Props extends PropsDefinition = undefined
  >(
    callback: (
      style: Style
    ) => DefineRulesPatternOptions<Input, Context, Variants, Props>
  ): ScopedRulesWith<Style, Variants, Props>;

  extends<
    ParentVariants extends VariantGroups,
    ParentProps extends ComplexPropDefinitions<PropTarget | undefined>,
    Variants extends ScopedVariants<Input, Context>,
    Props extends PropsDefinition = undefined
  >(
    parent: RuntimeFn<ParentVariants, ParentProps>,
    options: DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props,
      ExtendedVariants<
        ParentVariants,
        ResolvedVariants<Exclude<Variants, undefined>>
      >
    > & { variants: Variants },
    debugId?: string
  ): RuntimeFn<
    ExtendedVariants<
      ParentVariants,
      ResolvedVariants<Exclude<Variants, undefined>>
    >,
    ExtendedProps<ParentProps, Props>
  >;
  extends<
    ParentVariants extends VariantGroups,
    ParentProps extends ComplexPropDefinitions<PropTarget | undefined>,
    Variants extends ScopedVariants<Input, Context> | undefined = undefined,
    Props extends PropsDefinition = undefined
  >(
    parent: RuntimeFn<ParentVariants, ParentProps>,
    options: DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props,
      ExtendedVariants<
        ParentVariants,
        ResolvedVariants<Exclude<Variants, undefined>>
      >
    >,
    debugId?: string
  ): RuntimeFn<
    ExtendedVariants<
      ParentVariants,
      ResolvedVariants<Exclude<Variants, undefined>>
    >,
    ExtendedProps<ParentProps, Props>
  >;
}

/** Resolve scoped authoring styles before using the existing recipe compiler.
 * Generated recipes keep the same serialization, runtime and optimization path.
 */
export function createDefineRulesRules<Input, Context>(css: {
  raw(input: never): CSSRule;
}): DefineRulesRules<Input, Context> {
  type Options = PatternOptions<
    VariantGroups,
    ComplexPropDefinitions<PropTarget>
  >;

  function resolveStyle(
    input: unknown
  ): CSSRule | string | Array<CSSRule | string> {
    // A string in a recipe is a composed class, as it is in standalone rules().
    if (typeof input === "string") return input;
    if (Array.isArray(input))
      return input.flatMap((entry) => resolveStyle(entry));
    return css.raw(input as never);
  }

  function raw(options: Options): Options {
    const {
      base,
      variants,
      compoundVariants,
      props,
      defaultVariants,
      ...styles
    } = options;
    return {
      ...css.raw(styles as never),
      ...(base === undefined ? {} : { base: resolveStyle(base) }),
      ...(variants === undefined
        ? {}
        : {
            variants: mapValues(variants, (group) =>
              mapValues(group, resolveStyle)
            )
          }),
      props,
      defaultVariants,
      ...(compoundVariants === undefined
        ? {}
        : {
            compoundVariants: (conditions) =>
              compoundVariants(conditions).map(({ condition, style }) => ({
                condition,
                style: resolveStyle(style)
              }))
          })
    };
  }

  return Object.assign(
    (options: Options, debugId?: string) => rootRules(raw(options), debugId),
    {
      raw,
      multiple: (patterns: Record<string, Options>, debugId?: string) =>
        rootRules.multiple(mapValues(patterns, raw), debugId),
      with: (callback: (style: unknown) => Options) =>
        rootRules.with((style) => raw(callback(style))),
      extends: (
        parent: RuntimeFn<VariantGroups, ComplexPropDefinitions<PropTarget>>,
        options: Options,
        debugId?: string
      ) => rootRules.extends(parent, raw(options), debugId)
    }
  ) as DefineRulesRules<Input, Context>;
}
