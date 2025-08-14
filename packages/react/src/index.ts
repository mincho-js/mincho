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
import {
  ComponentProps,
  ComponentType,
  ElementType,
  ForwardRefExoticComponent,
  JSX,
  ReactNode,
  RefAttributes
} from "react";

export { $$styled } from "./runtime.js";

type KeyofIntrinsicElements = keyof JSX.IntrinsicElements;

export type DefaultPropsType = Record<never, never>;
export interface WithAsProp<AsComponent extends ElementType> {
  as?: AsComponent;
}

export type ComponentPropWithAs<
  Component extends ElementType,
  AsComponent extends ElementType,
  Props extends object
> = Omit<ComponentProps<Component>, keyof Props> &
  Omit<ComponentProps<AsComponent>, keyof Props> &
  WithAsProp<AsComponent> &
  Props;

export interface ComponentWithAs<
  Props extends object = DefaultPropsType,
  Component extends ElementType = ElementType
> {
  <AsComponent extends ElementType = Component>(
    props: ComponentPropWithAs<Component, AsComponent, Props>
  ): ReactNode;

  /**
   * Ignored by React.
   * @deprecated Only kept in types for backwards compatibility. Will be removed in a future major release.
   */
  propTypes?: unknown;
  /**
   * Used in debugging messages. You might want to set it
   * explicitly if you want to display a different name for
   * debugging purposes.
   *
   * @see {@link https://legacy.reactjs.org/docs/react-component.html#displayname Legacy React Docs}
   */
  displayName?: string;
  readonly $$typeof: symbol;
}

export type StyledComponent<
  TProps = Record<string, unknown>,
  Component extends ElementType = ElementType,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
> = ComponentWithAs<
  TProps &
    RefAttributes<unknown> &
    PatternOptionsToProps<Variants, ToggleVariants, Props>,
  Component
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
  : never;

type InferStyledComponentProps<Component> =
  Component extends KeyofIntrinsicElements
    ? IntrinsicProps<Component>
    : Component extends ComponentType<infer ComponentTypeProps>
      ? ComponentTypeProps
      : Component extends ForwardRefExoticComponent<infer ForwardRefProps>
        ? ForwardRefProps
        : Component extends ComponentWithAs<infer WithAsProps, ElementType>
          ? WithAsProps
          : never;

type InferStyledComponentElement<Component> =
  Component extends KeyofIntrinsicElements
    ? Component
    : Component extends ElementType
      ? Component
      : Component extends ComponentWithAs<infer _WithAsProps, infer AsComponent>
        ? AsComponent
        : never;

export function styled<
  TProps,
  TComponent extends ForwardRefExoticComponent<TProps>,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  component: TComponent,
  options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<TProps, TComponent, Variants, ToggleVariants, Props>;

export function styled<
  TProps,
  TComponent extends ComponentType<TProps>,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  component: TComponent,
  options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<TProps, TComponent, Variants, ToggleVariants, Props>;

export function styled<
  TProps extends object,
  TComponent extends ElementType,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  component: ComponentWithAs<TProps, TComponent>,
  options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<TProps, TComponent, Variants, ToggleVariants, Props>;

export function styled<
  TComponent extends KeyofIntrinsicElements,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  component: TComponent,
  options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<
  IntrinsicProps<TComponent>,
  TComponent,
  Variants,
  ToggleVariants,
  Props
>;

export function styled<
  Component extends
    | ForwardRefExoticComponent<unknown>
    | ComponentType<unknown>
    | KeyofIntrinsicElements
    | ComponentWithAs<object, ElementType>,
  Variants extends VariantGroups | undefined = undefined,
  ToggleVariants extends VariantDefinitions | undefined = undefined,
  Props extends ComplexPropDefinitions<PropTarget> | undefined = undefined
>(
  _component: Component,
  _options: PatternOptions<Variants, ToggleVariants, Props>
): StyledComponent<
  InferStyledComponentProps<Component>,
  InferStyledComponentElement<Component>,
  Variants,
  ToggleVariants,
  Props
> {
  throw new Error(
    "This function shouldn't be there in your final code. If you're seeing this, there is probably some issue with your build config."
  );
}
