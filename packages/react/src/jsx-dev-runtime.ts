import type { ElementType, Key, ReactElement } from "react";
import type { JSXSource } from "react/jsx-dev-runtime";
import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";

export { Fragment };
export type { JSX } from "./jsx-namespace.js";

const missedTransformErrorMessage =
  "Mincho JSX css prop was not compiled. Enable the Mincho transform with jsxCssProp: true and ensure it runs before React JSX transform.";

export function jsxDEV(
  type: ElementType,
  props: unknown,
  key: Key | undefined,
  isStatic: boolean,
  source?: JSXSource,
  self?: unknown
): ReactElement {
  if (hasOwnCssProp(props)) {
    throw new Error(missedTransformErrorMessage);
  }

  return reactJsxDEV(type, props, key, isStatic, source, self);
}

function hasOwnCssProp(props: unknown): boolean {
  return (
    typeof props === "object" &&
    props !== null &&
    Object.prototype.hasOwnProperty.call(props, "css")
  );
}

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("Mincho development JSX runtime", () => {
    it("throws when an own css prop survives transform", () => {
      const props = { css: "base" };

      expect(() =>
        jsxDEV("div", props, undefined, false, undefined, undefined)
      ).toThrow(missedTransformErrorMessage);
    });

    it("passes through props without an own css prop", () => {
      const props = { id: "root" };
      const element = jsxDEV(
        "div",
        props,
        undefined,
        false,
        undefined,
        undefined
      );

      expect(element.type).toBe("div");
      expect(element.props).toBe(props);
    });

    it("does not throw for inherited css props", () => {
      const props = Object.assign(Object.create({ css: { color: "red" } }), {
        id: "root"
      });
      const element = jsxDEV(
        "div",
        props,
        undefined,
        false,
        undefined,
        undefined
      );

      expect(element.type).toBe("div");
      expect(element.props).toBe(props);
    });
  });
}
