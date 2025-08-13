import {
  ComplexPropDefinitions,
  ConditionalVariants,
  PatternOptions,
  PropTarget,
  VariantDefinitions,
  VariantGroups,
  VariantObjectSelection,
  PropDefinitionOutput,
  ResolveComplex
} from "@mincho-js/css";
import { NonNullableString } from "@mincho-js/csstype";
import {
  ComponentType,
  ElementType,
  ForwardRefExoticComponent,
  JSX,
  PropsWithChildren,
  RefAttributes
} from "react";

export { $$styled } from "./runtime.js";

type KeyofIntrinsicElements = keyof JSX.IntrinsicElements;

export type StyledComponent<
  TProps = Record<string, unknown>,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
> = ForwardRefExoticComponent<
  PropsWithChildren<
    TProps & { as?: ElementType } & RefAttributes<unknown> &
      PatternOptionsToProps<Variants, ToggleVariants, Props>
  >
>;

export type PatternOptionsToProps<
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
> = ResolveComplex<
  NonNever<
    VariantObjectSelection<ConditionalVariants<Variants, ToggleVariants>>
  > &
    NonNever<PropDefinitionOutput<Exclude<Props, undefined>>>
>;
type NonNever<T> = [T] extends [never] ? unknown : T;

type IntrinsicProps<TComponent> = TComponent extends KeyofIntrinsicElements
  ? JSX.IntrinsicElements[TComponent]
  : TComponent extends ComponentType<infer Props>
    ? Props
    : never;

export function styled<
  TProps,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  component: ComponentType<TProps>,
  options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<TProps, Variants, ToggleVariants, Props>;

export function styled<
  TComponent extends NonNullableString | KeyofIntrinsicElements,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  component: TComponent,
  options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<IntrinsicProps<TComponent>, Variants, ToggleVariants, Props>;

export function styled<
  TComponentOrProps,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  _component:
    | ComponentType<TComponentOrProps>
    | NonNullableString
    | KeyofIntrinsicElements,
  _options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<TComponentOrProps, Variants, ToggleVariants, Props> {
  throw new Error(
    "This function shouldn't be there in your final code. If you're seeing this, there is probably some issue with your build config."
  );
}
