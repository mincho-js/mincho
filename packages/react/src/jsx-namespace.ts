import type { ComplexCSSRule } from "@mincho-js/css";
import type { JSX as ReactJSX } from "react";

import type { SupportedElements } from "./tags.js";

type MinchoCSSProp = {
  css?: ComplexCSSRule;
};

type MinchoIntrinsicElements = {
  [Element in SupportedElements]: ReactJSX.IntrinsicElements[Element] &
    MinchoCSSProp;
};

// eslint-disable-next-line @typescript-eslint/no-namespace -- TypeScript scoped JSX runtimes are modeled as exported JSX namespaces.
export declare namespace JSX {
  type ElementType = ReactJSX.ElementType;
  type Element = ReactJSX.Element;
  type ElementClass = ReactJSX.ElementClass;
  type ElementAttributesProperty = ReactJSX.ElementAttributesProperty;
  type ElementChildrenAttribute = ReactJSX.ElementChildrenAttribute;
  type LibraryManagedAttributes<Component, Props> =
    ReactJSX.LibraryManagedAttributes<Component, Props>;
  type IntrinsicAttributes = ReactJSX.IntrinsicAttributes;
  type IntrinsicClassAttributes<Element> =
    ReactJSX.IntrinsicClassAttributes<Element>;
  type IntrinsicElements = Omit<ReactJSX.IntrinsicElements, SupportedElements> &
    MinchoIntrinsicElements;
}

if (import.meta.vitest) {
  const { describe, it, assertType, expectTypeOf } = import.meta.vitest;

  describe("scoped Mincho JSX namespace", () => {
    it("adds css only to supported intrinsic elements", () => {
      const cssRule: ComplexCSSRule = { color: "red" };

      assertType<JSX.IntrinsicElements["div"]>({
        css: cssRule
      });

      assertType<ReactJSX.IntrinsicElements["div"]>({
        // @ts-expect-error React's unscoped intrinsic div props do not include Mincho css.
        css: cssRule
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
