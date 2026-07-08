import type { ClassValue, ComplexCSSRule } from "@mincho-js/css";
import type { JSX as ReactJSX } from "react";

export type MinchoCssPropValue = ComplexCSSRule | ClassValue;

type MinchoCssProp = {
  css?: MinchoCssPropValue;
};

type WithConditionalCSSProp<Props> = "className" extends keyof Props
  ? string extends NonNullable<Props["className"]>
    ? Props & MinchoCssProp
    : Props
  : Props;

type MinchoIntrinsicElements<
  IntrinsicElements extends object = ReactJSX.IntrinsicElements
> = {
  [Element in keyof IntrinsicElements]: WithConditionalCSSProp<
    IntrinsicElements[Element]
  >;
};

// eslint-disable-next-line @typescript-eslint/no-namespace -- TypeScript scoped JSX runtimes are modeled as exported JSX namespaces.
export declare namespace JSX {
  type ElementType = ReactJSX.ElementType;
  type Element = ReactJSX.Element;
  type ElementClass = ReactJSX.ElementClass;
  type ElementAttributesProperty = ReactJSX.ElementAttributesProperty;
  type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
  type LibraryManagedAttributes<Component, Props> = WithConditionalCSSProp<
    ReactJSX.LibraryManagedAttributes<Component, Props>
  >;
  type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
  type IntrinsicClassAttributes<Element> =
    ReactJSX.IntrinsicClassAttributes<Element>;
  type IntrinsicElements = MinchoIntrinsicElements;
}

if (import.meta.vitest) {
  const { describe, it, assertType, expectTypeOf } = import.meta.vitest;

  describe("scoped Mincho JSX namespace", () => {
    it("defines css values from ComplexCSSRule and ClassValue", () => {
      const cssRule: ComplexCSSRule = { color: "red" };
      const condition = true as boolean;
      const providedClass: string | undefined =
        Math.random() > 0.5 ? "base" : undefined;
      const maybeClass: string | null = Math.random() > 0.5 ? null : "base";
      const getClassName = () => "base";

      assertType<MinchoCssPropValue>(cssRule);
      assertType<MinchoCssPropValue>("base");
      assertType<MinchoCssPropValue>(false);
      assertType<MinchoCssPropValue>(null);
      assertType<MinchoCssPropValue>(undefined);
      assertType<MinchoCssPropValue>(["base", condition && "active"]);
      assertType<MinchoCssPropValue>(condition ? "base" : "fallback");
      assertType<MinchoCssPropValue>(condition && "active");
      assertType<MinchoCssPropValue>(condition || "fallback");
      assertType<MinchoCssPropValue>(maybeClass ?? "fallback");
      assertType<MinchoCssPropValue>(getClassName());
      assertType<MinchoCssPropValue>({ active: condition });
      assertType<MinchoCssPropValue>(providedClass || { color: "red" });
      assertType<MinchoCssPropValue>(maybeClass ?? [{ color: "red" }]);
      // @ts-expect-error TypeScript rejects always-truthy object literal logical left operands before Mincho css prop typing.
      // eslint-disable-next-line no-constant-binary-expression -- The constant operand is the TypeScript error under test.
      assertType<MinchoCssPropValue>({ color: "red" } || providedClass);
      // @ts-expect-error TypeScript rejects never-nullish object literal nullish left operands before Mincho css prop typing.
      // eslint-disable-next-line no-constant-binary-expression -- The constant operand is the TypeScript error under test.
      assertType<MinchoCssPropValue>({ color: "red" } ?? providedClass);
      // @ts-expect-error TypeScript rejects always-truthy object literal logical left operands before Mincho css prop typing.
      // eslint-disable-next-line no-constant-binary-expression -- The constant operand is the TypeScript error under test.
      assertType<MinchoCssPropValue>({ color: "red" } && providedClass);
    });

    it("adds css to string-compatible intrinsic className props", () => {
      const cssRule: ComplexCSSRule = { color: "red" };
      const condition = true as boolean;
      const providedClass: string | undefined =
        Math.random() > 0.5 ? "base" : undefined;
      const maybeClass: string | null = Math.random() > 0.5 ? null : "base";
      const getClassName = () => "base";

      assertType<JSX.IntrinsicElements["div"]>({
        css: "base"
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: false
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", condition && "active"]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: condition ? "base" : "fallback"
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: condition && "active"
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: condition || "fallback"
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: maybeClass ?? "fallback"
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: getClassName()
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: { color: "red" }
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: providedClass || { color: "red" }
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: maybeClass ?? [{ color: "red" }]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        // @ts-expect-error TypeScript rejects always-truthy object literal logical left operands before Mincho css prop typing.
        // eslint-disable-next-line no-constant-binary-expression -- The constant operand is the TypeScript error under test.
        css: { color: "red" } || providedClass
      });

      assertType<JSX.IntrinsicElements["div"]>({
        // @ts-expect-error TypeScript rejects never-nullish object literal nullish left operands before Mincho css prop typing.
        // eslint-disable-next-line no-constant-binary-expression -- The constant operand is the TypeScript error under test.
        css: { color: "red" } ?? providedClass
      });

      assertType<JSX.IntrinsicElements["div"]>({
        // @ts-expect-error TypeScript rejects always-truthy object literal logical left operands before Mincho css prop typing.
        // eslint-disable-next-line no-constant-binary-expression -- The constant operand is the TypeScript error under test.
        css: { color: "red" } && providedClass
      });

      assertType<ReactJSX.IntrinsicElements["div"]>({
        // @ts-expect-error React's unscoped intrinsic div props do not include Mincho css.
        css: cssRule
      });
    });

    it("uses the same className gate for user-augmented intrinsic props", () => {
      type UserAugmentedIntrinsicElements = MinchoIntrinsicElements<{
        "literal-class-element": { className?: "base" };
        "my-element": { className?: string; id?: string };
        "number-class-element": { className?: number };
        "required-class-element": { className: string };
        "undefined-class-element": { className?: string | undefined };
        "without-class-element": { id?: string };
      }>;

      assertType<UserAugmentedIntrinsicElements["my-element"]>({
        css: "base",
        id: "root"
      });

      assertType<UserAugmentedIntrinsicElements["required-class-element"]>({
        className: "root",
        css: false
      });

      assertType<UserAugmentedIntrinsicElements["undefined-class-element"]>({
        css: { color: "red" }
      });

      assertType<UserAugmentedIntrinsicElements["without-class-element"]>({
        // @ts-expect-error intrinsic props without className do not accept css.
        css: "base"
      });

      assertType<UserAugmentedIntrinsicElements["number-class-element"]>({
        className: 1,
        // @ts-expect-error numeric className props do not accept css.
        css: "base"
      });

      assertType<UserAugmentedIntrinsicElements["literal-class-element"]>({
        className: "base",
        // @ts-expect-error literal-only className props do not accept css.
        css: "base"
      });
    });

    it("uses the same className gate for custom component props", () => {
      type Component<Props> = (props: Props) => ReactJSX.Element;
      type ManagedProps<Props> = JSX.LibraryManagedAttributes<
        Component<Props>,
        Props
      >;

      const condition: boolean = Math.random() > 0.5;
      const functionCss = () => "base";
      const maybeClass: string | null = Math.random() > 0.5 ? null : "base";
      const getClassName = () => "base";

      assertType<ManagedProps<{ className?: string; label: string }>>({
        css: "base",
        label: "Button"
      });

      assertType<ManagedProps<{ className: string; label: string }>>({
        className: "root",
        css: false,
        label: "Button"
      });

      assertType<
        ManagedProps<{ className?: string | undefined; label: string }>
      >({
        css: { color: "red" },
        label: "Button"
      });

      assertType<ManagedProps<{ className?: string; label: string }>>({
        css: condition ? "base" : "fallback",
        label: "Button"
      });

      assertType<ManagedProps<{ className?: string; label: string }>>({
        css: condition && "active",
        label: "Button"
      });

      assertType<ManagedProps<{ className?: string; label: string }>>({
        css: condition || "fallback",
        label: "Button"
      });

      assertType<ManagedProps<{ className?: string; label: string }>>({
        css: maybeClass ?? "fallback",
        label: "Button"
      });

      assertType<ManagedProps<{ className?: string; label: string }>>({
        css: getClassName(),
        label: "Button"
      });

      assertType<ManagedProps<{ className?: string; label: string }>>({
        label: "Button",
        // @ts-expect-error function-valued css identifiers are not valid css prop values.
        css: getClassName
      });

      assertType<ManagedProps<{ label: string }>>({
        label: "Button",
        // @ts-expect-error custom components without className do not accept css.
        css: "base"
      });

      assertType<ManagedProps<{ className?: number; label: string }>>({
        className: 1,
        label: "Button",
        // @ts-expect-error numeric className props do not accept css.
        css: "base"
      });

      assertType<ManagedProps<{ className?: "base"; label: string }>>({
        className: "base",
        label: "Button",
        // @ts-expect-error literal-only className props do not accept css.
        css: "base"
      });

      assertType<ManagedProps<{ className?: string; label: string }>>({
        label: "Button",
        // @ts-expect-error function-valued css identifiers are not valid css prop values.
        css: functionCss
      });
    });

    it("does not add css through broad custom component attributes", () => {
      expectTypeOf<"css">().not.toExtend<keyof JSX.IntrinsicAttributes>();

      assertType<{ label: string }>({
        label: "Button",
        // @ts-expect-error custom components must opt into their own css prop explicitly.
        css: { color: "red" }
      });
    });
  });
}
