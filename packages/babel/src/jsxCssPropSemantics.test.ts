import { describe, expect, it } from "vitest";
import { babelTransform, runJsxCssPropRuntime } from "./testUtils/plugin.js";
import { transformCss } from "@vanilla-extract/css/transformCss";

it("bounds independent CSS array alternatives", () => {
  const fragments = Array.from(
    { length: 7 },
    (_, index) => `p.on${index} && {width: p.width}`
  );
  expect(() =>
    babelTransform(
      `function App(p) { return <div css={[${fragments.join(",")}]} />; }`,
      {
        jsxCssProp: true
      }
    )
  ).toThrow();
});

it.each([
  "width",
  "paddingInline",
  "marginBlock",
  "borderWidth",
  "gap",
  "fontSize",
  "lineHeight",
  "zIndex",
  "opacity",
  "flexGrow",
  "scale",
  "WebkitLineClamp",
  "strokeWidth",
  "strokeDasharray",
  "borderImageWidth",
  "--custom"
])(
  "matches the installed static CSS serializer's numeric units for %s",
  (property) => {
    const staticCss = transformCss({
      localClassNames: ["example"],
      composedClassLists: [],
      cssObjs: [
        {
          type: "local",
          selector: "example",
          rule: property.startsWith("--")
            ? { vars: { [property]: "10" } }
            : { [property]: 10 }
        }
      ]
    }).join("\n");
    const propertySource = property === "--custom" ? '"--custom"' : property;
    const runtimeValue = runJsxCssPropRuntime(
      `function App(p) { return <div css={{ ${propertySource}: p.value }} />; }`,
      'return App({value:10}).style["css-rule"];'
    );
    expect(staticCss).toContain(`: ${runtimeValue};`);
  }
);

describe.each([false, true])(
  "dynamic CSS value semantics (runtimeCodegen=%s)",
  (runtimeCodegen) => {
    it.each(["width", "margin", "gap", "top", "fontSize"])(
      "gives numeric %s the same px unit as a static value",
      (property) => {
        const result = runJsxCssPropRuntime(
          `function App(p) { return <div css={{ ${property}: p.value }} />; }`,
          'return [10, 0, -2.5, "2rem", "auto"].map(value => App({value}).style["css-rule"]);',
          runtimeCodegen
        );
        expect(result).toEqual(["10px", "0px", "-2.5px", "2rem", "auto"]);
      }
    );

    it.each(["zIndex", "opacity", "lineHeight", "flexGrow"])(
      "preserves unitless %s values",
      (property) => {
        const result = runJsxCssPropRuntime(
          `function App(p) { return <div css={{ ${property}: p.value }} />; }`,
          'return [0, 1.5].map(value => App({value}).style["css-rule"]);',
          runtimeCodegen
        );
        expect(result).toEqual([0, 1.5]);
      }
    );

    it("normalizes captured values once without changing prop evaluation order", () => {
      const observed = runJsxCssPropRuntime(
        `const events = [];
       const take = (name, value) => (events.push(name), value);
       function App() { return <div
         className={take("class", "plain")}
         css={{ width: take("width", 10) }}
         style={take("style", {color:"red"})}
       />; }`,
        'const props = App(); return {value: props.style["css-rule"], events};',
        runtimeCodegen
      );
      expect(observed).toEqual({
        value: "10px",
        events: ["class", "width", "style"]
      });
    });

    it.each(['p.color + " !important"', "`" + "${p.color} !important`"])(
      "keeps declaration priority outside the custom property: %s",
      (value) => {
        const source = `function App(p) { return <div css={{ color: ${value} }} style={p.style} />; }`;
        const { result } = babelTransform(source, {
          jsxCssProp: true,
          optimize: { runtimeCodegen }
        });
        expect(result[1]).toContain(' + " !important"');
        expect(
          runJsxCssPropRuntime(
            source,
            'return App({color:"blue",style:{}}).style["css-rule"];',
            runtimeCodegen
          )
        ).toBe("blue");
      }
    );

    it("preserves multi-hole and calc templates as runtime strings", () => {
      const source =
        "function App(p) { return <div css={{width: `calc(${p.width}px + ${p.gap}rem)`}} />; }";
      expect(
        runJsxCssPropRuntime(
          source,
          'return App({width:10,gap:2}).style["css-rule"];',
          runtimeCodegen
        )
      ).toBe("calc(10px + 2rem)");
    });

    it("preserves conditional array fragments and their lazy values", () => {
      const source = `
      const base = { padding: 4 };
      const events = [];
      function readWidth(p) { events.push("width"); return p.width; }
      function App(p) {
        return <div css={[base, p.on && { width: readWidth(p) }]} />;
      }
    `;
      expect(
        runJsxCssPropRuntime(
          source,
          'const off = App({on:false,width:10}); const on = App({on:true,width:10}); return [off.style?.["css-rule"], on.style?.["css-rule"], events];',
          runtimeCodegen
        )
      ).toEqual([undefined, "10px", ["width"]]);
    });

    it("evaluates independent array branches once in source order", () => {
      const source = `
      const events = [];
      function read(name, value) { events.push(name); return value; }
      function App(p) {
        return <div css={[
          read("a", true) && {width: read("width", p.width)},
          read("b", false) && {height: read("height", p.height)},
          read("c", true) ? {margin: read("margin", p.margin)} : {padding: read("padding", p.padding)}
        ]} />;
      }
    `;
      expect(
        runJsxCssPropRuntime(
          source,
          "App({width:10,height:20,margin:3,padding:4}); return events;",
          runtimeCodegen
        )
      ).toEqual(["a", "width", "b", "c", "margin"]);
    });
  }
);
