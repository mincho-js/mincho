import { describe, expect, it } from "vitest";
import { babelTransform } from "../testUtils/plugin.js";

const source = `
import { defineRules, css } from "@mincho-js/css";
const owner = defineRules({ properties: { color: true, display: true } });
const cls = css([owner.css({ color: "red", display: "flex" })]);
export function App() { return <div className={cls}/>; }
`;

const enabled = {
  experimental: { globalAtomicClasses: true, compileClass: true }
};

describe("compiler-owned class strategies", () => {
  it("preserves default output and independently disabled options", () => {
    const original = babelTransform(source);

    expect(
      babelTransform(source, {
        experimental: { globalAtomicClasses: false, compileClass: false }
      })
    ).toEqual(original);
    expect(original.result[1]).not.toContain("compilePrivateDefineRulesClass");
  });

  it.each([
    { globalAtomicClasses: true },
    { compileClass: true },
    { globalAtomicClasses: true, compileClass: true }
  ])(
    "lowers private static class results into the build-only helper: %j",
    (experimental) => {
      const result = babelTransform(source, { experimental });

      expect(result.result[1]).toContain("compilePrivateDefineRulesClass");
      expect(result.result[1]).toContain(
        `globalAtomicClasses: ${experimental.globalAtomicClasses === true}`
      );
      expect(result.result[1]).toContain(
        `compileClass: ${experimental.compileClass === true}`
      );
      expect(result.code).not.toContain("compilePrivateDefineRulesClass(");
      expect(result.code).not.toContain("defineRules");
      expect(result.code).not.toContain("const owner");
      expect(result.metadata.minchoClassStrategies).toEqual({
        transformedCalls: 1,
        atomicDomain: "file"
      });
    }
  );

  it("supports private destructured css and direct intrinsic class use", () => {
    const result = babelTransform(
      `
      import { defineRules, css } from "@mincho-js/css";
      const {css: atomic} = defineRules({properties:{color:true}});
      export function App(){return <span className={css([atomic({color:"red"})])}/>;}
    `,
      enabled
    );

    expect(result.result[1]).toContain("compilePrivateDefineRulesClass(atomic");
  });

  it.each([
    'css([owner.css({color:"red"}), "outside"])',
    'css([owner.css({color:"red"}), {display:"flex"}])',
    'css([owner.css({color:"red"})], "public-debug-name")'
  ])("keeps broader composition wrappers scoped: %s", (composition) => {
    const candidate = source.replace(
      'css([owner.css({ color: "red", display: "flex" })])',
      composition
    );

    expect(babelTransform(candidate, enabled).result[1]).not.toContain(
      "compilePrivateDefineRulesClass"
    );
  });

  it.each([
    "export {cls};",
    "export {owner};",
    "const preset = owner.preset;",
    "const merge = owner.cx;",
    "owner.css = other;",
    "inspect(cls);",
    'eval("cls");',
    "const selector = `.${cls}`;",
    "const composed = [cls];"
  ])("preserves escaped owner/class use: %s", (escape) => {
    expect(babelTransform(source + escape, enabled).result[1]).not.toContain(
      "compilePrivateDefineRulesClass"
    );
  });

  it.each([
    "<Widget className={cls}/>",
    "<x-widget className={cls}/>",
    "<div {...props} className={cls}/>",
    '<div className={cls} css={{color:"blue"}}/>',
    '<div className={cls + " external"}/>',
    "<div className={merge(cls, other)}/>"
  ])("preserves unknown class consumption: %s", (jsx) => {
    expect(
      babelTransform(source.replace("<div className={cls}/>", jsx), enabled)
        .result[1]
    ).not.toContain("compilePrivateDefineRulesClass");
  });

  it.each([
    "{color: runtime}",
    "{color: read()}",
    "{...props}",
    '{get color(){ return "red"; }}',
    '{[name]: "red"}'
  ])("does not extract a dynamic class input: %s", (input) => {
    const candidate = source.replace(
      '{ color: "red", display: "flex" }',
      input
    );

    expect(babelTransform(candidate, enabled).result[1]).not.toContain(
      "compilePrivateDefineRulesClass"
    );
  });

  it("retains scoped identities around an intervening global style", () => {
    const result = babelTransform(
      source
        .replace(
          "const cls =",
          'globalCss("[data-x]", {color:"blue"}); const cls ='
        )
        .replace("defineRules, css", "defineRules, css, globalCss"),
      enabled
    );

    expect(result.result[1]).not.toContain("compilePrivateDefineRulesClass");
    expect(result.metadata.minchoClassStrategies).toMatchObject({
      atomicDomain: "scoped",
      fallback: "intervening-or-unknown-styles"
    });
  });

  it("respects explicit extraction ignore comments", () => {
    const result = babelTransform(
      source.replace("css([owner.css", "/* mincho-js-ignore */ css([owner.css"),
      enabled
    );

    expect(result.code).not.toContain("compilePrivateDefineRulesClass");
    expect(result.result[1]).not.toContain("compilePrivateDefineRulesClass");
  });

  it("retains scoped classes when later JSX preprocessing can introduce styles", () => {
    const result = babelTransform(
      source + 'export const other = <div css={{color:"blue"}}/>;',
      { ...enabled, jsxCssProp: true }
    );

    expect(result.result[1]).not.toContain("compilePrivateDefineRulesClass");
    expect(result.metadata.minchoClassStrategies).toMatchObject({
      fallback: "intervening-or-unknown-styles"
    });
  });

  it.each([
    'properties: { color: { brand: {color:"red"} } }',
    'properties: { color: true }, conditions: {hover:"&:hover"}',
    "properties: { color: true }, presets: other",
    'properties: { color: true }, shortcuts: {brand:{color:"red"}}'
  ])("keeps unknown owner semantics scoped: %s", (config) => {
    expect(
      babelTransform(
        source.replace("properties: { color: true, display: true }", config),
        enabled
      ).result[1]
    ).not.toContain("compilePrivateDefineRulesClass");
  });

  it("requires every call of an owner to remain within the independent subset", () => {
    const candidate =
      source.replace(
        "color: true, display: true",
        "color: true, display: true, cursor:true"
      ) +
      `
      const cursor = css([owner.css({cursor:'url("./cursor.svg"), pointer'})]);
      export const node = <div className={cursor}/>;
    `;

    expect(babelTransform(candidate, enabled).result[1]).not.toContain(
      "compilePrivateDefineRulesClass"
    );
  });
});
