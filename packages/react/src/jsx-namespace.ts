import type { ClassPrimitive, ComplexCSSRule } from "@mincho-js/css";
import type { JSX as ReactJSX } from "react";

type ComplexCSSRuleArrayItem = Extract<ComplexCSSRule, unknown[]>[number];
type MinchoCssPropRecursiveArrayItem =
  | ComplexCSSRuleArrayItem
  | ClassPrimitive
  | MinchoCssPropRecursiveArray;
type MinchoCssPropRecursiveArray =
  | MinchoCssPropRecursiveArrayItem[]
  | readonly MinchoCssPropRecursiveArrayItem[];

export type MinchoCssPropValue =
  | ComplexCSSRule
  | ClassPrimitive
  | MinchoCssPropRecursiveArray;

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

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assertType, expectTypeOf } = import.meta.vitest;

  describe("scoped Mincho JSX namespace", () => {
    it("defines css values from ComplexCSSRule and ClassPrimitive", () => {
      const cssRule: ComplexCSSRule = { color: "red" };
      const condition = true as boolean;
      const activeClass = "active-class";
      const styles = { active: "styles-active" };
      const nested = true as boolean;
      const providedClassName: string = Math.random() > 0.5 ? "base" : "";
      const providedClass: string | undefined =
        Math.random() > 0.5 ? "base" : undefined;
      const maybeClass: string | null = Math.random() > 0.5 ? null : "base";
      const getClassName = () => "base";
      const emptyClassName: ClassPrimitive = "";

      expectTypeOf<MinchoCssPropValue>().toEqualTypeOf<
        ComplexCSSRule | ClassPrimitive | MinchoCssPropRecursiveArray
      >();

      assertType<ClassPrimitive>(emptyClassName);
      assertType<MinchoCssPropValue>(cssRule);
      assertType<MinchoCssPropValue>("base");
      assertType<MinchoCssPropValue>(emptyClassName);
      assertType<MinchoCssPropValue>(false);
      assertType<MinchoCssPropValue>(true);
      assertType<MinchoCssPropValue>(null);
      assertType<MinchoCssPropValue>(undefined);
      assertType<MinchoCssPropValue>(1);
      assertType<MinchoCssPropValue>(0);
      assertType<MinchoCssPropValue>(0n);
      assertType<MinchoCssPropValue>(1n);
      assertType<MinchoCssPropValue>(condition ? "base" : "fallback");
      assertType<MinchoCssPropValue>(condition && "active");
      assertType<MinchoCssPropValue>(condition || "fallback");
      assertType<MinchoCssPropValue>(maybeClass ?? "fallback");
      assertType<MinchoCssPropValue>(getClassName());

      // Object literals in JSX css are CSS-rule syntax, not cx class dictionaries.
      assertType<MinchoCssPropValue>({ color: "red" });
      assertType<MinchoCssPropValue>({ color: condition ? "red" : "blue" });
      assertType<MinchoCssPropValue>(["base", "active"]);
      assertType<MinchoCssPropValue>(["base", ""]);
      assertType<MinchoCssPropValue>(["base", { color: "red" }]);
      assertType<MinchoCssPropValue>(["base", false]);
      assertType<MinchoCssPropValue>(["base", true]);
      assertType<MinchoCssPropValue>(["base", null]);
      assertType<MinchoCssPropValue>(["base", undefined]);
      assertType<MinchoCssPropValue>(["base", 0]);
      assertType<MinchoCssPropValue>(["base", 1]);
      assertType<MinchoCssPropValue>(["base", 0n]);
      assertType<MinchoCssPropValue>(["base", 1n]);
      assertType<MinchoCssPropValue>(["base", activeClass]);
      assertType<MinchoCssPropValue>(["base", "", activeClass]);
      assertType<MinchoCssPropValue>(["base", styles.active]);
      assertType<MinchoCssPropValue>(["base", getClassName()]);
      assertType<MinchoCssPropValue>(["base", condition && "active"]);
      assertType<MinchoCssPropValue>(["base", providedClassName && "active"]);
      assertType<MinchoCssPropValue>(["base", providedClass || "fallback"]);
      assertType<MinchoCssPropValue>(["base", maybeClass ?? "fallback"]);
      assertType<MinchoCssPropValue>([
        "base",
        condition ? "active" : "inactive"
      ]);
      assertType<MinchoCssPropValue>(["base", { color: "red" }, activeClass]);
      assertType<MinchoCssPropValue>([
        "base",
        providedClass || { color: "red" }
      ]);
      assertType<MinchoCssPropValue>(["base", maybeClass ?? { color: "red" }]);
      assertType<MinchoCssPropValue>([
        "base",
        condition ? { color: "red" } : "inactive"
      ]);
      assertType<MinchoCssPropValue>([
        "base",
        condition ? "active" : { color: "blue" }
      ]);
      assertType<MinchoCssPropValue>([
        "base",
        condition ? { color: "red" } : { color: "blue" }
      ]);
      assertType<MinchoCssPropValue>(condition && { color: "red" });
      assertType<MinchoCssPropValue>(condition && [{ color: "red" }]);
      assertType<MinchoCssPropValue>(providedClass || { color: "red" });
      assertType<MinchoCssPropValue>(maybeClass ?? [{ color: "red" }]);
      assertType<MinchoCssPropValue>([
        "base",
        ["nested", condition && { color: "red" }]
      ]);
      assertType<MinchoCssPropValue>([
        "base",
        condition && ["active", nested && { color: "red" }]
      ]);
      assertType<MinchoCssPropValue>([
        "base",
        condition
          ? ["active", { color: "red" }]
          : ["fallback", { color: "blue" }]
      ]);
      assertType<MinchoCssPropValue>([["base", false]]);
      assertType<MinchoCssPropValue>([[1]]);

      // ClassValue-only object dictionaries with non-CSS keys are rejected.
      // CSS-shaped objects, for example `{ color: "red" }`, are intentionally
      // accepted as CSS-rule syntax and cannot be distinguished structurally.
      // @ts-expect-error Direct class dictionaries are not css prop values.
      assertType<MinchoCssPropValue>({ active: condition });
      // @ts-expect-error Direct class dictionaries are not css prop values.
      assertType<MinchoCssPropValue>({ "is-active": true });
      assertType<MinchoCssPropValue>(cssRule || providedClass);
      assertType<MinchoCssPropValue>(cssRule ?? providedClass);
      assertType<MinchoCssPropValue>(cssRule && providedClass);
    });

    it("adds css to string-compatible intrinsic className props", () => {
      const cssRule: ComplexCSSRule = { color: "red" };
      const condition = true as boolean;
      const activeClass = "active-class";
      const nested = true as boolean;
      const providedClassName: string = Math.random() > 0.5 ? "base" : "";
      const providedClass: string | undefined =
        Math.random() > 0.5 ? "base" : undefined;
      const maybeClass: string | null = Math.random() > 0.5 ? null : "base";
      const getClassName = () => "base";

      assertType<JSX.IntrinsicElements["div"]>({
        css: "base"
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ""
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: 1
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: false
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: true
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: null
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: undefined
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: 0
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: 0n
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: 1n
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", "active"]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", ""]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", false]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", true]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", null]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", undefined]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", 0]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", 1]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", 0n]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", 1n]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", activeClass]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", getClassName()]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", condition && "active"]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", providedClassName && "active"]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", condition ? "active" : "inactive"]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", providedClass || { color: "red" }]
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
        css: condition && [{ color: "red" }]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", { color: "red" }, activeClass]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", ["nested", condition && { color: "red" }]]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: ["base", condition && ["active", nested && { color: "red" }]]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: [
          "base",
          condition
            ? ["active", { color: "red" }]
            : ["fallback", { color: "blue" }]
        ]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: providedClass || { color: "red" }
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: maybeClass ?? [{ color: "red" }]
      });

      assertType<JSX.IntrinsicElements["div"]>({
        // @ts-expect-error Direct class dictionaries are not css prop values.
        css: { active: condition }
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: cssRule || providedClass
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: cssRule ?? providedClass
      });

      assertType<JSX.IntrinsicElements["div"]>({
        css: cssRule && providedClass
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

      const functionCss = () => "base";
      const maybeClass: string | null = Math.random() > 0.5 ? null : "base";
      const getClassName = () => "base";
      const condition = true as boolean;

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
