import type { ElementType, Key, ReactElement } from "react";
import type { JSXSource } from "react/jsx-dev-runtime";
import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import {
  missedTransformErrorMessage,
  throwForOwnCssProp
} from "./jsxCssPropRuntimeGuard.js";

export { Fragment };
export type { JSX } from "./jsx-namespace.js";

export function jsxDEV(
  type: ElementType,
  props: unknown,
  key: Key | undefined,
  isStatic: boolean,
  source?: JSXSource,
  self?: unknown
): ReactElement {
  throwForOwnCssProp(props);

  return reactJsxDEV(type, props, key, isStatic, source, self);
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
