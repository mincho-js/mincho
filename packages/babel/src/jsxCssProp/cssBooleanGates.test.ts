import { describe, expect, it } from "vitest";
import { babelTransform } from "../testUtils/plugin.js";

const options = { jsxCssProp: true, experimental: { cssBooleanGates: true } };

const code = (expression: string, attributes = "") =>
  `export const App = () => <div ${attributes} css={${expression}}/>;`;

describe("CSS boolean gates", () => {
  it("keeps the default lowering and emits gates only with explicit opt-in", () => {
    const input = code(
      'active ? {color:"red",opacity:1} : {color:"blue",opacity:0.5}'
    );

    const before = babelTransform(input, { jsxCssProp: true });

    expect(before.result[1]).not.toContain("factorCssBooleanGates");

    const after = babelTransform(input, options);

    expect(after.result[1]).toContain("factorCssBooleanGates");
    expect(after.result[1]).toContain('"initial"');
    expect(after.code).toContain("active ? 0 : 1");
    expect(after.code).not.toContain("factorCssBooleanGates");
    expect(after.code).not.toContain('color: "red"');
  });

  it("preserves conditional short circuit evaluation and nested CSS positions", () => {
    const branch = (color: string) =>
      `{color:"${color}","@media":{"(min-width: 800px)":{opacity:0.5}},selectors:{"&:hover":{color:"${color}"}}}`;

    const output = babelTransform(
      code(
        `first() ? second() ? ${branch("red")} : ${branch("blue")} : ${branch("green")}`
      ),
      options
    );

    expect(output.code).toContain("first() ? second() ? 0 : 1 : 2");
    expect(output.code.match(/first\(\)/g)).toHaveLength(1);
    expect(output.code.match(/second\(\)/g)).toHaveLength(1);
    expect(output.result[1]).toContain('"@media"');
    expect(output.result[1]).toContain('"&:hover"');
  });

  it.each([
    'active && {color:"red"}',
    'active ? {color:"red"} : {}',
    'active ? {color:"red"} : {color:null}',
    "active ? {margin:1} : {margin:2}",
    'active ? {color:"inherit"} : {color:"red"}',
    'active ? {color:"var(--other)"} : {color:"red"}',
    'active ? {color:"red)"} : {color:"red"}',
    "active ? {color:value} : {color:other}",
    'active ? {selectors:{"&::before":{color:"red"}}} : {selectors:{"&::before":{color:"blue"}}}'
  ])("preserves unsupported branches: %s", (expression) => {
    const input = code(expression);

    expect(babelTransform(input, options)).toEqual(
      babelTransform(input, { jsxCssProp: true })
    );
  });

  it.each(['className="external"', 'style={{color:"green"}}', "{...props}"])(
    "preserves potentially conflicting attributes: %s",
    (attrs) => {
      const input = code('active ? {color:"red"} : {color:"blue"}', attrs);

      expect(babelTransform(input, options)).toEqual(
        babelTransform(input, { jsxCssProp: true })
      );
    }
  );
});
