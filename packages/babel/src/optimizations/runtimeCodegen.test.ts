import { describe, expect, it } from "vitest";
import { babelTransform } from "../testUtils/plugin.js";

describe("runtime code generation", () => {
  it("imports generated class merging from the pure runtime and removes orphan css imports", () => {
    const result = babelTransform(
      'export function App(flag) {return <div className="base" css={flag ? "active" : "inactive"}/>;}',
      { jsxCssProp: true }
    );

    expect(result.code).toContain('from "@mincho-js/css/classname"');
    expect(result.code).not.toContain('from "@mincho-js/css"');

    const branch = babelTransform(
      'export function App(flag) {return <div css={{color: flag ? "red" : "blue"}}/>;}',
      { jsxCssProp: true }
    );

    expect(branch.code).not.toContain('from "@mincho-js/css"');
    expect(branch.result[1]).toContain("@mincho-js/css");
  });

  it("retains authored module effects while removing generated helpers", () => {
    const { code } = babelTransform(
      'import "@mincho-js/css"; export function App(flag) {return <div css={{color: flag ? "red" : "blue"}}/>;}',
      { jsxCssProp: true }
    );

    expect(code).toContain('import "@mincho-js/css"');
  });

  it.each([false, true])(
    "does not turn an empty type-only import into effects with authored effects %s",
    (authoredEffect) => {
      const { code, result } = babelTransform(
        `import type {} from "@mincho-js/css"; ${authoredEffect ? 'import "@mincho-js/css";' : ""} export function App(flag) {return <div css={{color: flag ? "red" : "blue"}}/>;}`,
        { jsxCssProp: true }
      );

      expect(result[1]).toContain("@mincho-js/css");
      expect(code.includes('import "@mincho-js/css"')).toBe(authoredEffect);
    }
  );

  it.each([false, true])(
    "removes generated CommonJS helpers with authored effects %s",
    (authoredEffect) => {
      const { code, result } = babelTransform(
        `${authoredEffect ? 'require("@mincho-js/css");' : ""}
         exports.App = function App(flag) {
           return <div css={{color: flag ? "red" : "blue"}}/>;
         };`,
        { jsxCssProp: true },
        { filename: "view.tsx", sourceType: "unambiguous" }
      );

      expect(result[1]).toContain("@mincho-js/css");
      expect(code).not.toMatch(/import\s/);
      expect(code).not.toMatch(/require\("@mincho-js\/css"\)\.css/);
      expect(code.includes('require("@mincho-js/css")')).toBe(authoredEffect);
    }
  );
});
