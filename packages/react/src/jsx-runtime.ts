import { Fragment, jsx, jsxs } from "react/jsx-runtime";

export { Fragment, jsx, jsxs };
export type { JSX } from "./jsx-namespace.js";

if (import.meta.vitest) {
  const { describe, it, expect } = import.meta.vitest;

  describe("Mincho production JSX runtime", () => {
    it("passes through surviving css props without styling or throwing", () => {
      const props = { css: { color: "red" }, id: "root" };

      expect(() => jsx("div", props, undefined)).not.toThrow();

      const element = jsx("div", props, undefined);

      expect(element.type).toBe("div");
      expect(element.props).toBe(props);
    });
  });
}
