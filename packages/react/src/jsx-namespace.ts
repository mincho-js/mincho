import type { ClassPrimitive, ComplexCSSRule } from "@mincho-js/css";
import type { CSSProperties, JSX as ReactJSX } from "react";
import type { CssPropConfig } from "./index.js";

type CssPropRule = CssPropConfig extends {
  css: (...args: infer Args) => unknown;
}
  ? Args[0]
  : ComplexCSSRule;

// Configured sources receive a complete style array in one call, so its elements
// are available only when the selected CSS function accepts arrays.
type CssPropRuleArrayItem<Rule> = Extract<Rule, readonly unknown[]>[number];
type MinchoCssPropRecursiveArrayItem<Rule> =
  | CssPropRuleArrayItem<Rule>
  | ClassPrimitive
  | MinchoCssPropRecursiveArray<Rule>;
type MinchoCssPropRecursiveArray<Rule = CssPropRule> =
  | MinchoCssPropRecursiveArrayItem<Rule>[]
  | readonly MinchoCssPropRecursiveArrayItem<Rule>[];

type CssPropValue<Rule> =
  Rule | ClassPrimitive | MinchoCssPropRecursiveArray<Rule>;

export type MinchoCssPropValue = CssPropValue<CssPropRule>;

type MinchoCssProp<Rule> = {
  css?: CssPropValue<Rule>;
};

// A polymorphic component's inferred index signature is not a css declaration.
type DeclaredCssProp<Props> = {
  [Key in keyof Props as Key extends "css" ? Key : never]: Props[Key];
};

type WithConditionalCSSProp<Props, Rule = CssPropRule> = Props extends unknown
  ? "css" extends keyof DeclaredCssProp<Props>
    ? Props
    : "className" extends keyof Props
      ? string extends NonNullable<Props["className"]>
        ? "style" extends keyof Props
          ? CSSProperties extends NonNullable<Props["style"]>
            ? NonNullable<Props["style"]> extends CSSProperties
              ? Props & MinchoCssProp<Rule>
              : Props
            : Props
          : Props
        : Props
      : Props
  : never;

type CssPropFunction = (...args: never[]) => unknown;
type DefaultCssPropFunction = (rule: CssPropRule) => unknown;

/**
 * Adds a scoped css prop using a CSS function's first argument.
 * Explicit function types do not read the global CssPropConfig augmentation.
 * An existing css declaration remains the component's own contract.
 */
export type WithCssProp<
  Props,
  Css extends CssPropFunction
> = WithConditionalCSSProp<Props, Parameters<Css>[0]>;

type MinchoIntrinsicElements<
  IntrinsicElements extends object = ReactJSX.IntrinsicElements,
  Css extends CssPropFunction = DefaultCssPropFunction
> = {
  [Element in keyof IntrinsicElements]: WithCssProp<
    IntrinsicElements[Element],
    Css
  >;
};

/**
 * Scoped JSX contracts shared by Mincho and preset runtimes.
 * Pass a CSS function to IntrinsicElements and LibraryManagedAttributes to
 * select its input. Omitting it preserves the default CssPropConfig contract.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace -- TypeScript scoped JSX runtimes are modeled as exported JSX namespaces.
export declare namespace CssPropJSX {
  type ElementType = ReactJSX.ElementType;
  type Element = ReactJSX.Element;
  type ElementClass = ReactJSX.ElementClass;
  type ElementAttributesProperty = ReactJSX.ElementAttributesProperty;
  type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
  type LibraryManagedAttributes<
    Component,
    Props,
    Css extends CssPropFunction = DefaultCssPropFunction
  > = WithCssProp<ReactJSX.LibraryManagedAttributes<Component, Props>, Css>;
  type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
  type IntrinsicClassAttributes<Element> =
    ReactJSX.IntrinsicClassAttributes<Element>;
  type IntrinsicElements<Css extends CssPropFunction = DefaultCssPropFunction> =
    MinchoIntrinsicElements<ReactJSX.IntrinsicElements, Css>;
}

// The JSX checker needs concrete intrinsic attributes, not a generic type alias.
// eslint-disable-next-line @typescript-eslint/no-namespace -- TypeScript scoped JSX runtimes are modeled as exported JSX namespaces.
export declare namespace JSX {
  type ElementType = CssPropJSX.ElementType;
  type Element = CssPropJSX.Element;
  type ElementClass = CssPropJSX.ElementClass;
  type ElementAttributesProperty = CssPropJSX.ElementAttributesProperty;
  type ElementChildrenAttribute = CssPropJSX.ElementChildrenAttribute;
  type LibraryManagedAttributes<Component, Props> =
    CssPropJSX.LibraryManagedAttributes<Component, Props>;
  type IntrinsicAttributes = CssPropJSX.IntrinsicAttributes;
  type IntrinsicClassAttributes<Element> =
    CssPropJSX.IntrinsicClassAttributes<Element>;
  type IntrinsicElements = CssPropJSX.IntrinsicElements;
}

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, assertType, expectTypeOf } = import.meta.vitest;

  describe("scoped Mincho JSX namespace", () => {
    it("keeps explicit CSS definitions independent of the default namespace", () => {
      type PresetRule = { bg?: "blue-500" | "blue-700"; px?: 2 | 3 };
      const _presetCss = (_rule: PresetRule | readonly PresetRule[]) =>
        "preset";
      type PresetProps = CssPropJSX.IntrinsicElements<
        typeof _presetCss
      >["button"];

      expectTypeOf<PresetProps>().toEqualTypeOf<
        WithCssProp<ReactJSX.IntrinsicElements["button"], typeof _presetCss>
      >();

      assertType<PresetProps>({ css: { bg: "blue-500", px: 3 } });
      assertType<PresetProps>({ css: ["external", [{ px: 2 }]] as const });
      assertType<PresetProps>({ css: false });

      assertType<PresetProps>({
        // @ts-expect-error the selected definition retains its token values.
        css: { bg: "unknown-color" }
      });
      assertType<PresetProps>({
        // @ts-expect-error a preset input does not inherit default CSS properties.
        css: { padding: 12 }
      });

      assertType<JSX.IntrinsicElements["button"]>({ css: { padding: 12 } });
      assertType<JSX.IntrinsicElements["button"]>({
        // @ts-expect-error scoped preset properties do not augment default JSX.
        css: { bg: "blue-500" }
      });
      assertType<ReactJSX.IntrinsicElements["button"]>({
        // @ts-expect-error scoped css props do not augment React's namespace.
        css: { bg: "blue-500" }
      });

      const _otherCss = (_rule: { foreground?: "primary" }) => "other";
      type OtherProps = CssPropJSX.IntrinsicElements<
        typeof _otherCss
      >["button"];

      assertType<OtherProps>({ css: { foreground: "primary" } });
      assertType<OtherProps>({
        // @ts-expect-error two explicit definitions keep separate vocabularies.
        css: { bg: "blue-500" }
      });
    });

    it("keeps custom CSS functions' array support and forwarding gates", () => {
      const _objectCss = (_rule: { bg?: "blue-500" }) => "preset";
      type ForwardingProps = {
        className?: string;
        style?: CSSProperties;
        label: string;
      };
      type Component = (props: ForwardingProps) => ReactJSX.Element;
      type ManagedProps = CssPropJSX.LibraryManagedAttributes<
        Component,
        ForwardingProps,
        typeof _objectCss
      >;

      assertType<ManagedProps>({ label: "Button", css: { bg: "blue-500" } });
      assertType<ManagedProps>({ label: "Button", css: ["external", false] });
      assertType<ManagedProps>({
        label: "Button",
        // @ts-expect-error object-only functions do not accept style arrays.
        css: [{ bg: "blue-500" }]
      });

      expectTypeOf<
        WithCssProp<{ className?: string; label: string }, typeof _objectCss>
      >().toEqualTypeOf<{ className?: string; label: string }>();
      expectTypeOf<
        WithCssProp<
          { className?: "fixed"; style?: CSSProperties },
          typeof _objectCss
        >
      >().toEqualTypeOf<{ className?: "fixed"; style?: CSSProperties }>();
      expectTypeOf<
        WithCssProp<{ className?: string; style?: string }, typeof _objectCss>
      >().toEqualTypeOf<{ className?: string; style?: string }>();

      type OwnCssProps = ForwardingProps & { css: "own-css-contract" };
      type OwnCssComponent = (props: OwnCssProps) => ReactJSX.Element;

      expectTypeOf<
        CssPropJSX.LibraryManagedAttributes<
          OwnCssComponent,
          OwnCssProps,
          typeof _objectCss
        >
      >().toEqualTypeOf<OwnCssProps>();
    });

    it("preserves explicit component css contracts through scoped JSX", () => {
      type PresetRule = { bg?: "blue-500" | "blue-700"; px?: 2 | 3 };
      const _presetCss = (_rule: PresetRule | readonly PresetRule[]) =>
        "preset";
      type PresetProps = WithCssProp<
        ReactJSX.IntrinsicElements["button"],
        typeof _presetCss
      >;
      type Component = (props: PresetProps) => ReactJSX.Element;
      type ManagedProps = JSX.LibraryManagedAttributes<Component, PresetProps>;

      assertType<ManagedProps>({ css: { bg: "blue-500", px: 3 } });
      assertType<ManagedProps>({
        css: ["external", [{ bg: "blue-700", px: 2 }]] as const
      });
      assertType<ManagedProps>({ css: false });
      expectTypeOf<ManagedProps>().toEqualTypeOf<PresetProps>();

      assertType<ManagedProps>({
        // @ts-expect-error JSX preserves the selected definition's token values.
        css: { bg: "unknown-color" }
      });
      assertType<ManagedProps>({
        // @ts-expect-error JSX does not widen the explicit contract to default CSS.
        css: { padding: 12 }
      });

      type IndexedProps = PresetProps & { [name: string]: unknown };
      type IndexedComponent = (props: IndexedProps) => ReactJSX.Element;
      type IndexedManagedProps = JSX.LibraryManagedAttributes<
        IndexedComponent,
        IndexedProps
      >;

      assertType<IndexedManagedProps>({
        css: [{ bg: "blue-500", px: 3 }] as const,
        custom: true
      });
      expectTypeOf<IndexedManagedProps>().toEqualTypeOf<IndexedProps>();
      assertType<IndexedManagedProps>({
        // @ts-expect-error A string index does not widen an explicit css prop.
        css: { padding: 12 }
      });

      type UnionProps =
        | (PresetProps & { kind: "preset" })
        | {
            kind: "native";
            className?: string;
            style?: CSSProperties;
          };
      type UnionComponent = (props: UnionProps) => ReactJSX.Element;
      type UnionManagedProps = JSX.LibraryManagedAttributes<
        UnionComponent,
        UnionProps
      >;

      assertType<UnionManagedProps>({
        kind: "preset",
        css: [{ bg: "blue-500" }] as const
      });
      assertType<UnionManagedProps>({ kind: "native", css: { padding: 12 } });
      // @ts-expect-error The preset branch retains its explicit token contract.
      assertType<UnionManagedProps>({ kind: "preset", css: { padding: 12 } });

      type RequiredProps = PresetProps & {
        css: NonNullable<PresetProps["css"]>;
      };
      type RequiredComponent = (props: RequiredProps) => ReactJSX.Element;
      type RequiredManagedProps = JSX.LibraryManagedAttributes<
        RequiredComponent,
        RequiredProps
      >;

      assertType<RequiredManagedProps>({ css: { bg: "blue-500" } });
      // @ts-expect-error JSX keeps an explicitly required css prop required.
      assertType<RequiredManagedProps>({});
    });

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

    it("uses the same className and style gate for user-augmented intrinsic props", () => {
      type UserAugmentedIntrinsicElements = MinchoIntrinsicElements<{
        "literal-class-element": { className?: "base" };
        "my-element": {
          className?: string;
          id?: string;
          style?: CSSProperties;
        };
        "number-class-element": { className?: number; style?: CSSProperties };
        "required-class-element": { className: string; style: CSSProperties };
        "string-style-element": { className?: string; style?: string };
        "union-style-element": {
          className?: string;
          style?: CSSProperties | string;
        };
        "undefined-class-element": {
          className?: string | undefined;
          style?: CSSProperties | undefined;
        };
        "without-class-element": { id?: string };
        "without-style-element": { className?: string; id?: string };
      }>;

      assertType<UserAugmentedIntrinsicElements["my-element"]>({
        css: "base",
        id: "root"
      });

      assertType<UserAugmentedIntrinsicElements["required-class-element"]>({
        className: "root",
        style: { color: "red" },
        css: false
      });

      assertType<UserAugmentedIntrinsicElements["undefined-class-element"]>({
        css: { color: "red" }
      });

      assertType<UserAugmentedIntrinsicElements["without-class-element"]>({
        // @ts-expect-error intrinsic props without className do not accept css.
        css: "base"
      });

      assertType<UserAugmentedIntrinsicElements["without-style-element"]>({
        id: "root",
        // @ts-expect-error intrinsic props without style do not accept css.
        css: "base"
      });

      assertType<UserAugmentedIntrinsicElements["union-style-element"]>({
        style: { color: "red" },
        // @ts-expect-error style unions broader than CSSProperties do not accept css.
        css: "base"
      });

      assertType<UserAugmentedIntrinsicElements["string-style-element"]>({
        style: "color: red",
        // @ts-expect-error non-React style props do not accept css.
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

    it("requires className and style-compatible custom component props", () => {
      type Component<Props> = (props: Props) => ReactJSX.Element;
      type ManagedProps<Props> = JSX.LibraryManagedAttributes<
        Component<Props>,
        Props
      >;
      type ForwardingProps = {
        className?: string;
        style?: CSSProperties;
        label: string;
      };

      const functionCss = () => "base";
      const maybeClass: string | null = Math.random() > 0.5 ? null : "base";
      const getClassName = () => "base";
      const condition = true as boolean;

      assertType<ManagedProps<ForwardingProps>>({
        css: "base",
        label: "Button"
      });

      assertType<
        ManagedProps<{
          className: string;
          style: CSSProperties;
          label: string;
        }>
      >({
        className: "root",
        style: { color: "red" },
        css: false,
        label: "Button"
      });

      assertType<
        ManagedProps<{
          className?: string | undefined;
          style?: CSSProperties | undefined;
          label: string;
        }>
      >({
        css: { color: "red" },
        label: "Button"
      });

      assertType<ManagedProps<ForwardingProps>>({
        css: condition ? "base" : "fallback",
        label: "Button"
      });

      assertType<ManagedProps<ForwardingProps>>({
        css: condition && "active",
        label: "Button"
      });

      assertType<ManagedProps<ForwardingProps>>({
        css: condition || "fallback",
        label: "Button"
      });

      assertType<ManagedProps<ForwardingProps>>({
        css: maybeClass ?? "fallback",
        label: "Button"
      });

      assertType<ManagedProps<ForwardingProps>>({
        css: getClassName(),
        label: "Button"
      });

      assertType<ManagedProps<ForwardingProps>>({
        label: "Button",
        // @ts-expect-error function-valued css identifiers are not valid css prop values.
        css: getClassName
      });

      assertType<ManagedProps<{ label: string }>>({
        label: "Button",
        // @ts-expect-error custom components without className do not accept css.
        css: "base"
      });

      assertType<ManagedProps<{ className?: string; label: string }>>({
        label: "Button",
        // @ts-expect-error custom components without style do not accept css.
        css: "base"
      });

      assertType<
        ManagedProps<{
          className?: string;
          style?: string;
          label: string;
        }>
      >({
        style: "color: red",
        label: "Button",
        // @ts-expect-error non-React style props do not accept css.
        css: "base"
      });

      assertType<
        ManagedProps<{
          className?: number;
          style?: CSSProperties;
          label: string;
        }>
      >({
        className: 1,
        label: "Button",
        // @ts-expect-error numeric className props do not accept css.
        css: "base"
      });

      assertType<
        ManagedProps<{
          className?: "base";
          style?: CSSProperties;
          label: string;
        }>
      >({
        className: "base",
        label: "Button",
        // @ts-expect-error literal-only className props do not accept css.
        css: "base"
      });

      assertType<ManagedProps<ForwardingProps>>({
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
