import type { ElementType, Key, ReactElement } from "react";
import {
  Fragment,
  jsx as reactJsx,
  jsxs as reactJsxs
} from "react/jsx-runtime";

export { Fragment };
export type { JSX } from "./jsx-namespace.js";

const missedTransformErrorMessage =
  "Mincho JSX css prop was not compiled. Enable the Mincho transform with jsxCssProp: true and ensure it runs before React JSX transform.";

export function jsx(
  type: ElementType,
  props: unknown,
  key?: Key
): ReactElement {
  throwForOwnCssProp(props);

  return reactJsx(type, props, key);
}

export function jsxs(
  type: ElementType,
  props: unknown,
  key?: Key
): ReactElement {
  throwForOwnCssProp(props);

  return reactJsxs(type, props, key);
}

function throwForOwnCssProp(props: unknown) {
  if (hasOwnCssProp(props)) {
    throw new Error(missedTransformErrorMessage);
  }
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

  describe("Mincho production JSX runtime", () => {
    it("throws when an own css prop survives transform through jsx", () => {
      expect(() => jsx("div", { css: "base" }, undefined)).toThrow(
        missedTransformErrorMessage
      );
    });

    it("throws when an own css prop survives transform through jsxs", () => {
      expect(() =>
        jsxs("div", { children: ["child"], css: { color: "red" } }, undefined)
      ).toThrow(missedTransformErrorMessage);
    });

    it("passes through props without an own css prop", () => {
      const props = { id: "root" };

      expect(() => jsx("div", props, undefined)).not.toThrow();

      const element = jsx("div", props, undefined);

      expect(element.type).toBe("div");
      expect(element.props).toBe(props);
    });

    it("does not throw for inherited css props", () => {
      const props = Object.assign(Object.create({ css: "base" }), {
        id: "root"
      });
      const element = jsx("div", props, undefined);

      expect(element.type).toBe("div");
      expect(element.props).toBe(props);
    });
  });
}
