import type { CSSRule } from "@mincho-js/transform-to-vanilla";
import type { DefineRulesDirectCssInput } from "./types.js";
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

type ValidatedStyle<Style, Input> = Style extends (
  ...args: infer Args
) => infer Result
  ? (...args: Args) => DefineRulesDirectCssInput<Result, Input>
  : DefineRulesDirectCssInput<Style, Input>;

type ValidatedVariantValues<Values, Input> = {
  [Value in keyof Values]: ValidatedStyle<Values[Value], Input>;
};

type ValidatedVariants<Groups, Input> = {
  [Group in keyof Groups]: ValidatedVariantValues<Groups[Group], Input>;
};

type ValidatedCompounds<Callback, Input> = Callback extends (
  ...args: infer Args
) => infer Compounds
  ? (...args: Args) => {
      [Index in keyof Compounds]: Compounds[Index] extends {
        style: infer Style;
      }
        ? Omit<Compounds[Index], "style"> & {
            style: ValidatedStyle<Style, Input>;
          }
        : Compounds[Index];
    }
  : Callback;

type ValidatedPattern<Options, Input> = {
  [Key in keyof Options]: Key extends "base"
    ? ValidatedStyle<Options[Key], Input>
    : Key extends "variants"
      ? ValidatedVariants<Options[Key], Input>
      : Key extends "compoundVariants"
        ? ValidatedCompounds<Options[Key], Input>
        : Key extends keyof Input
          ? DefineRulesDirectCssInput<Options[Key], Input[Key]>
          : Options[Key];
};

type PatternInputGate<
  Options,
  Input,
  Validate extends boolean
> = Validate extends true
  ? [Options] extends [ValidatedPattern<Options, Input>]
    ? unknown
    : never
  : unknown;

// Limit the inference capture to known keys so fresh object literals keep the
// ordinary excess-property checks. Optional captures also accept typed inputs
// whose supported fields are optional.
type PatternInputCapture<
  Options,
  Input,
  Validate extends boolean
> = Validate extends true
  ? {
      [
        Key in keyof Options &
          (
            | keyof Input
            | "base"
            | "variants"
            | "props"
            | "defaultVariants"
            | "compoundVariants"
          )
      ]?: Options[Key];
    }
  : unknown;

/** Reuses scoped recipe input validation in authoring adapters. */
export type DefineRulesPatternInput<
  Options,
  Input,
  Validate extends boolean = false
> = PatternInputCapture<Options, Input, Validate> &
  PatternInputGate<NoInfer<Options>, Input, Validate>;

type PatternsInputCapture<
  Patterns,
  Input,
  Validate extends boolean
> = Validate extends true
  ? { [Key in keyof Patterns]: PatternInputCapture<Patterns[Key], Input, true> }
  : unknown;

type StyleInputCapture<
  Args,
  Style,
  Input,
  Validate extends boolean
> = Validate extends true
  ? {
      [Key in keyof Args & keyof Style]?: Key extends keyof Input
        ? DefineRulesDirectCssInput<Args[Key], Input[Key]>
        : Args[Key];
    }
  : unknown;

type ScopedResult<Variants, Props extends PropsDefinition> = RuntimeFn<
  ResolvedVariants<Exclude<Variants, undefined>>,
  Exclude<Props, undefined>
>;

type StyleInputGate<
  Style,
  Input,
  Validate extends boolean
> = Validate extends true
  ? [Pick<Style, keyof Style & keyof Input>] extends [
      DefineRulesDirectCssInput<Pick<Style, keyof Style & keyof Input>, Input>
    ]
    ? unknown
    : never
  : unknown;

type PatternsInputGate<
  Patterns,
  Input,
  Validate extends boolean
> = Validate extends true
  ? { [Key in keyof Patterns]: PatternInputGate<Patterns[Key], Input, true> }
  : unknown;

type ScopedPatterns<Input, Context, Variants, Props> = {
  [Key in keyof Variants]: DefineRulesPatternOptions<
    Input,
    Context,
    Variants[Key],
    PatternProps<Props, Key>
  >;
} & {
  [Key in keyof Props]: { props?: Props[Key] & PropsDefinition };
};

type ExtendedPatternOptions<
  Input,
  Context,
  ParentVariants extends VariantGroups,
  Variants,
  Props extends PropsDefinition
> = DefineRulesPatternOptions<
  Input,
  Context,
  Variants,
  Props,
  ExtendedVariants<
    ParentVariants,
    ResolvedVariants<Exclude<Variants, undefined>>
  >
>;

interface ScopedRulesWith<
  Style,
  Variants,
  Props extends PropsDefinition,
  Input,
  Validate extends boolean
> {
  <const Args extends Style>(
    style: Style & StyleInputCapture<Args, Style, Input, Validate>,
    debugId?: string
  ): ScopedResult<Variants, Props>;
  raw<const Args extends Style>(
    style: Style & StyleInputCapture<Args, Style, Input, Validate>
  ): PatternOptions<ResolvedVariants<Exclude<Variants, undefined>>, Props>;
  multiple<const Styles extends Record<string | number, Style>>(
    styles: Styles &
      (Validate extends true
        ? {
            [Key in keyof Styles]: StyleInputGate<Styles[Key], Input, true>;
          }
        : unknown),
    debugId?: string
  ): { [Key in keyof Styles]: ScopedResult<Variants, Props> };
  extends<
    ParentVariants extends VariantGroups,
    ParentProps extends ComplexPropDefinitions<PropTarget | undefined>,
    const Args extends Style = Style
  >(
    parent: RuntimeFn<ParentVariants, ParentProps>,
    style: Style & StyleInputCapture<Args, Style, Input, Validate>,
    debugId?: string
  ): RuntimeFn<
    ExtendedVariants<
      ParentVariants,
      ResolvedVariants<Exclude<Variants, undefined>>
    >,
    ExtendedProps<ParentProps, Props>
  >;
}

export interface DefineRulesRules<
  Input,
  Context = undefined,
  ValidateEmptyInputs extends boolean = false
> {
  // Declared variants must infer even when every style is a context callback.
  // Separate optional overloads keep recipes without variants from widening.
  <
    Variants extends ScopedVariants<Input, Context>,
    Props extends PropsDefinition = undefined,
    const Options extends DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props
    > = DefineRulesPatternOptions<Input, Context, Variants, Props>
  >(
    options: DefineRulesPatternOptions<Input, Context, Variants, Props> & {
      variants: Variants;
    } & DefineRulesPatternInput<Options, Input, ValidateEmptyInputs>,
    debugId?: string
  ): ScopedResult<Variants, Props>;

  <
    Variants extends ScopedVariants<Input, Context> | undefined = undefined,
    Props extends PropsDefinition = undefined,
    const Options extends DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props
    > = DefineRulesPatternOptions<Input, Context, Variants, Props>
  >(
    options: DefineRulesPatternOptions<Input, Context, Variants, Props> &
      DefineRulesPatternInput<Options, Input, ValidateEmptyInputs>,
    debugId?: string
  ): ScopedResult<Variants, Props>;

  raw<
    Variants extends ScopedVariants<Input, Context>,
    Props extends PropsDefinition = undefined,
    const Options extends DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props
    > = DefineRulesPatternOptions<Input, Context, Variants, Props>
  >(
    options: DefineRulesPatternOptions<Input, Context, Variants, Props> & {
      variants: Variants;
    } & DefineRulesPatternInput<Options, Input, ValidateEmptyInputs>
  ): PatternOptions<ResolvedVariants<Exclude<Variants, undefined>>, Props>;

  raw<
    Variants extends ScopedVariants<Input, Context> | undefined = undefined,
    Props extends PropsDefinition = undefined,
    const Options extends DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props
    > = DefineRulesPatternOptions<Input, Context, Variants, Props>
  >(
    options: DefineRulesPatternOptions<Input, Context, Variants, Props> &
      DefineRulesPatternInput<Options, Input, ValidateEmptyInputs>
  ): PatternOptions<ResolvedVariants<Exclude<Variants, undefined>>, Props>;

  // Independent maps keep missing/optional fields in one recipe from widening
  // the inferred variants and runtime props of its siblings.
  multiple<
    Variants extends Record<string | number, unknown>,
    Props extends Record<string | number, unknown>,
    const Patterns extends ScopedPatterns<Input, Context, Variants, Props> =
      ScopedPatterns<Input, Context, Variants, Props>
  >(
    patterns: ScopedPatterns<Input, Context, Variants, Props> &
      PatternsInputCapture<Patterns, Input, ValidateEmptyInputs> &
      PatternsInputGate<NoInfer<Patterns>, Input, ValidateEmptyInputs>,
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
    Props extends PropsDefinition = undefined,
    const Options extends DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props
    > = DefineRulesPatternOptions<Input, Context, Variants, Props>
  >(
    callback: (style: Style) => DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props
    > & {
      variants: Variants;
    } & (ValidateEmptyInputs extends true ? Options : unknown) &
      PatternInputGate<NoInfer<Options>, Input, ValidateEmptyInputs>
  ): ScopedRulesWith<Style, Variants, Props, Input, ValidateEmptyInputs>;

  with<
    Style extends Input,
    Variants extends ScopedVariants<Input, Context> | undefined = undefined,
    Props extends PropsDefinition = undefined,
    const Options extends DefineRulesPatternOptions<
      Input,
      Context,
      Variants,
      Props
    > = DefineRulesPatternOptions<Input, Context, Variants, Props>
  >(
    callback: (
      style: Style
    ) => DefineRulesPatternOptions<Input, Context, Variants, Props> &
      (ValidateEmptyInputs extends true ? Options : unknown) &
      PatternInputGate<NoInfer<Options>, Input, ValidateEmptyInputs>
  ): ScopedRulesWith<Style, Variants, Props, Input, ValidateEmptyInputs>;

  extends<
    ParentVariants extends VariantGroups,
    ParentProps extends ComplexPropDefinitions<PropTarget | undefined>,
    Variants extends ScopedVariants<Input, Context>,
    Props extends PropsDefinition = undefined,
    const Options extends ExtendedPatternOptions<
      Input,
      Context,
      ParentVariants,
      Variants,
      Props
    > = ExtendedPatternOptions<Input, Context, ParentVariants, Variants, Props>
  >(
    parent: RuntimeFn<ParentVariants, ParentProps>,
    options: ExtendedPatternOptions<
      Input,
      Context,
      ParentVariants,
      Variants,
      Props
    > & { variants: Variants } & DefineRulesPatternInput<
        Options,
        Input,
        ValidateEmptyInputs
      >,
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
    Props extends PropsDefinition = undefined,
    const Options extends ExtendedPatternOptions<
      Input,
      Context,
      ParentVariants,
      Variants,
      Props
    > = ExtendedPatternOptions<Input, Context, ParentVariants, Variants, Props>
  >(
    parent: RuntimeFn<ParentVariants, ParentProps>,
    options: ExtendedPatternOptions<
      Input,
      Context,
      ParentVariants,
      Variants,
      Props
    > &
      DefineRulesPatternInput<Options, Input, ValidateEmptyInputs>,
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
export function createDefineRulesRules<
  Input,
  Context,
  ValidateEmptyInputs extends boolean = false
>(css: {
  raw(input: never): CSSRule;
}): DefineRulesRules<Input, Context, ValidateEmptyInputs> {
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
  ) as DefineRulesRules<Input, Context, ValidateEmptyInputs>;
}
