import {
  ComplexPropDefinitions,
  ConditionalVariants,
  PatternOptions,
  PropTarget,
  RuntimeFn,
  VariantDefinitions,
  VariantGroups,
  VariantSelection
} from "@mincho-js/css";
import {
  ComponentType,
  ElementType,
  ForwardRefExoticComponent,
  JSX,
  PropsWithChildren,
  RefAttributes
} from "react";

export * from "./runtime";

export type StyledComponent<
  TProps = Record<string, unknown>,
  Variants extends VariantGroups = VariantGroups
> = ForwardRefExoticComponent<
  PropsWithChildren<TProps & { as?: ElementType } & RefAttributes<unknown>>
> & {
  variants: Array<keyof Variants>;
  selector: RuntimeFn<Variants, never>;
  (props: PropsWithChildren<TProps & { as?: ElementType }>): JSX.Element;
};

type InstrinsicProps<TComponent> =
  TComponent extends keyof JSX.IntrinsicElements
    ? JSX.IntrinsicElements[TComponent]
    : TComponent extends ComponentType<infer P>
      ? P
      : never;

export function styled<
  TProps,
  Variants extends VariantGroups = VariantGroups,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  component: ComponentType<TProps>,
  options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<
  TProps & VariantSelection<ConditionalVariants<Variants, ToggleVariants>>,
  ConditionalVariants<Variants, ToggleVariants>
>;

export function styled<
  TComponent extends string | keyof JSX.IntrinsicElements,
  Variants extends VariantGroups = VariantGroups,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  component: TComponent,
  options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<
  InstrinsicProps<TComponent> &
    VariantSelection<ConditionalVariants<Variants, ToggleVariants>>,
  ConditionalVariants<Variants, ToggleVariants>
>;

export function styled<
  TComponentOrProps,
  Variants extends VariantGroups = VariantGroups,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  _component:
    | ComponentType<TComponentOrProps>
    | string
    | keyof JSX.IntrinsicElements,
  _options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<unknown, Variants> {
  throw new Error(
    "This function shouldn't be there in your final code. If you're seeing this, there is probably some issue with your build config."
  );
}
