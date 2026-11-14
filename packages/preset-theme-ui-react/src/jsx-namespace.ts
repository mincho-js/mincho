import type { css } from "./index.js";
import type { CssPropJSX } from "@mincho-js/react";

// eslint-disable-next-line @typescript-eslint/no-namespace -- TypeScript resolves automatic JSX types through this scoped namespace.
export declare namespace JSX {
  export type ElementType = CssPropJSX.ElementType;
  export type Element = CssPropJSX.Element;
  export type ElementClass = CssPropJSX.ElementClass;
  export type ElementAttributesProperty = CssPropJSX.ElementAttributesProperty;
  export type ElementChildrenAttribute = CssPropJSX.ElementChildrenAttribute;
  export type LibraryManagedAttributes<C, P> =
    CssPropJSX.LibraryManagedAttributes<C, P, typeof css>;
  export type IntrinsicAttributes = CssPropJSX.IntrinsicAttributes;
  export type IntrinsicClassAttributes<T> =
    CssPropJSX.IntrinsicClassAttributes<T>;
  export type IntrinsicElements = CssPropJSX.IntrinsicElements<typeof css>;
}
