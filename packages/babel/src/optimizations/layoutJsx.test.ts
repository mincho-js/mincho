import { describe, expect, it } from "vitest";
import { transformSync, type PluginObj } from "@babel/core";
import {
  babelTransform,
  jsxRuntimeTransformPlugin
} from "../testUtils/plugin.js";

const header = `import { Box, HStack, Item, Stack, VStack } from "@mincho-js/react/layout";\n`;

function lower(source: string, styledComponents?: boolean) {
  return babelTransform(header + source, {
    optimize: { styledComponents: styledComponents ?? true }
  });
}

describe("styledComponents layout lowering", () => {
  it.each([
    "<Item width={p.width} />",
    "{p.list.map(x => <Item width={x.width} />)}",
    "<><Item {...p} /></>",
    "<Child />",
    "{p.children}"
  ])("retains a provider for runtime or opaque children: %s", (children) => {
    for (const container of [
      "HStack",
      "VStack",
      'Stack axis="horizontal"',
      "Box",
      "Item"
    ]) {
      const name = container.split(" ")[0];
      const { code, result } = lower(
        `export const C = p => <${container}>${children}</${name}>;`
      );
      expect(code).toContain(`<${name}`);
      expect(result[1]).not.toContain(`compileLayoutClass("${name}"`);
    }
  });

  it.each(["Box", "Item"])("retains the null parent boundary of %s", (kind) => {
    const { code, result } = lower(
      `export const C = p => <HStack gap={p.gap}><${kind}><VStack width={p.width} /></${kind}></HStack>;`
    );
    expect(code).toContain(`<${kind}`);
    expect(result[1]).not.toContain(`compileLayoutClass("${kind}"`);
  });

  it.each([
    '<HStack gap={p.gap}><Item width="stretch" gapAfter={p.g} /><Item width="stretch" /></HStack>',
    '<VStack gap={p.gap}><Item height="stretch" /><Box height="stretch" /></VStack>',
    '<Stack axis={p.axis}><Item width="stretch" /></Stack>',
    '<HStack><Child /><Item width="stretch" /></HStack>',
    '<HStack gap={p.gap}><><Item width="stretch" /></></HStack>',
    '<HStack gap={p.gap}><div><Item width="stretch" /></div></HStack>',
    "<Box width={p.width}><VStack><Item width={32} /></VStack></Box>",
    "<Item width={p.width}><HStack><Box width={32} /></HStack></Item>",
    '<HStack children={<Item width="stretch" />} />'
  ])("retains static descendants of a runtime layout parent: %s", (jsx) => {
    const { code, result } = lower(`export const C = p => ${jsx};`);
    expect(code).toMatch(/<(?:Item|Box)\b/);
    expect(code).not.toContain("data-mincho-layout");
    expect(result[1]).not.toContain("compileLayoutClass");
  });

  it("still lowers independent static subtrees beside runtime ones", () => {
    const { code, result } = lower(`export const C = p => <>
      <HStack gap={p.gap}><Item width="stretch" /></HStack>
      <HStack gap={8}><Item width={32} /></HStack>
    </>;`);
    expect(code).toContain('<Item width="stretch"');
    expect(code).toContain('data-mincho-layout="HStack"');
    expect(result[1]).toMatch(/compileLayoutClass\("Item", \{\s*width: 32/);
    expect(result[1]).not.toContain('width: "stretch"');
  });

  it("retains providers when children are passed as a prop", () => {
    const { code } = lower(
      "export const C = p => <HStack children={p.children} />;"
    );
    expect(code).toContain("<HStack");
  });

  it("lowers static elements to intrinsic elements with extracted classes", () => {
    const { code, result } = lower(`
      export const Toolbar = () => (
        <HStack as="nav" width={400} gap={8} key="k" onClick={handle}>
          <Item width={40} gapBefore={20} />
          <VStack width="stretch" padding={{ horizontal: 12 }} />
          <Stack axis="vertical" />
          <Box position="absolute" top={0} />
        </HStack>
      );
    `);
    expect(code).not.toMatch(/<(?:HStack|Item|VStack|Stack|Box)\b/);
    expect(code).toContain('import "@mincho-js/css/layout.css";');
    expect(code).toMatch(
      /<nav key="k" onClick=\{handle\} data-mincho-layout="HStack" data-mincho-layout-axis="horizontal" className=\{[\w$]+\}/
    );
    expect(code).toContain('data-mincho-layout="Item"');
    expect(code).toContain(
      'data-mincho-layout="Stack" data-mincho-layout-axis="vertical"'
    );
    expect(code).toContain(
      'data-mincho-layout="Box" data-mincho-layout-out=""'
    );
    expect(result[1]).toContain('compileLayoutClass("HStack", {');
    expect(result[1]).toMatch(
      /compileLayoutClass\("Item", \{\s*width: 40,\s*gapBefore: 20\s*\}\)/
    );
    expect(result[1]).toMatch(/horizontal: 12/);
  });

  it("evaluates constant bindings and merges decoration classes", () => {
    const { code } = lower(`
      const GAP = 8;
      export const A = () => <HStack gap={GAP} className="row" />;
      export const B = (p) => <HStack className={p.className} />;
      export const C = () => <HStack style={{ color: "red" }} />;
    `);
    expect(code).toMatch(/className=\{[\w$]+ \+ " row"\}/);
    expect(code).toMatch(
      /className=\{\[[\w$]+, p\.className\]\.filter\(value => value\)\.join\(" "\)\}/
    );
    expect(code).toMatch(/style=\{\{\s*color: "red"\s*\}\}/);
  });

  it("preserves attribute evaluation order and ignores a shadowed Boolean", () => {
    const { code } = lower(`
      const calls = [];
      const Boolean = () => false;
      function record(value) { calls.push(value); return value; }
      function Example() {
        return <HStack className={record("class")} title={record("title")} />;
      }
    `);
    const executable = transformSync(code, {
      parserOpts: { plugins: ["jsx"] },
      plugins: [
        jsxRuntimeTransformPlugin(),
        (): PluginObj => ({
          visitor: {
            ImportDeclaration(path) {
              if (
                [
                  "@mincho-js/react/layout",
                  "@mincho-js/css/layout.css"
                ].includes(path.node.source.value)
              )
                path.remove();
            }
          }
        })
      ]
    });
    const result = new Function(
      "__minchoJsx",
      `${executable!.code}\nconst props = Example(); return { props, calls };`
    )((_tag: unknown, props: unknown) => props);
    expect(result).toEqual({
      props: {
        "data-mincho-layout": "HStack",
        "data-mincho-layout-axis": "horizontal",
        "data-mincho-layout-static": "{}",
        className: "css-rule class",
        title: "title"
      },
      calls: ["class", "title"]
    });
  });

  it.each([
    ["gap={(record(), 8)}", { gap: 8 }],
    ["gap={1 + (record(), 7)}", { gap: 8 }],
    ["gap={(void record()) || 8}", { gap: 8 }],
    [
      "padding={{ horizontal: (record(), 12) }}",
      { padding: { horizontal: 12 } }
    ]
  ])("preserves layout expression side effects in %s", (attributes, props) => {
    const { code, result } = lower(`
      const calls = [];
      function record() { calls.push("layout"); }
      function Example() { return <HStack ${attributes} />; }
    `);
    const executable = transformSync(code, {
      parserOpts: { plugins: ["jsx"] },
      plugins: [
        jsxRuntimeTransformPlugin(),
        (): PluginObj => ({
          visitor: { ImportDeclaration: (path) => path.remove() }
        })
      ]
    });
    const observed = new Function(
      "HStack",
      "__minchoJsx",
      `${executable!.code}\nconst props = Example(); return { props, calls };`
    )("HStack", (_tag: unknown, props: unknown) => props);
    expect(observed).toEqual({ props, calls: ["layout"] });
    expect(result[1]).not.toContain("compileLayoutClass");
  });

  it("preserves typography overflow styles when lowering", () => {
    const { code } = lower(`
      export const C = () => <Box style={{ overflowWrap: "anywhere" }} />;
    `);
    expect(code).toContain('data-mincho-layout="Box"');
    expect(code).toContain('overflowWrap: "anywhere"');
  });

  it.each([
    ["dynamic layout value", `(p) => <HStack gap={p.gap} />`],
    ["debugLayout", `() => <HStack debugLayout />`],
    ["spread", `(p) => <HStack {...p} />`],
    ["component as", `() => <HStack as={Custom} />`],
    ["opaque style", `(p) => <HStack style={p.style} />`],
    [
      "duplicate className",
      `() => <HStack className={first()} className={second()} />`
    ],
    ["dynamic Stack axis", `(p) => <Stack axis={p.axis} />`],
    ["shadowed process", `(process) => <Item width={100} />`]
  ])("keeps the runtime component for %s", (_, component) => {
    const { code, result } = lower(`export const C = ${component};`);
    expect(code).not.toContain("compileLayoutClass");
    expect(result[1]).not.toContain("compileLayoutClass");
    expect(code).not.toContain("layout.css");
  });

  it("supports aliased and namespace imports only from the React entry", () => {
    const { code } = babelTransform(
      `import { HStack as Row } from "@mincho-js/react/layout";
       import * as L from "@mincho-js/react/layout";
       import { HStack } from "./local";
       export const C = () => <><Row /><L.VStack /><HStack /></>;`,
      { optimize: { styledComponents: true } }
    );
    expect(code).toContain('data-mincho-layout="HStack"');
    expect(code).toContain('data-mincho-layout="VStack"');
    expect(code).toContain("<HStack />");
  });

  it("reports layout-owned inline styles at build time", () => {
    expect(() =>
      lower(`export const C = () => <HStack style={{ width: 10 }} />;`)
    ).toThrow(
      "E_LAYOUT_CAPABILITY: style.width conflicts with layout semantics"
    );
  });

  it.each([
    'placeSelf: "end"',
    'placeItems: "end"',
    'placeContent: "end"',
    'all: "unset"',
    'WebkitAlignItems: "flex-end"',
    "WebkitFlexGrow: 1",
    'WebkitBoxSizing: "content-box"',
    'WebkitLogicalWidth: "40px"'
  ])("rejects shorthands and aliases that reset layout styles: %s", (style) => {
    expect(() =>
      lower(`export const C = () => <HStack style={{ ${style} }} />;`)
    ).toThrow("E_LAYOUT_CAPABILITY");
  });

  it("keeps vendor-prefixed decoration that does not override layout", () => {
    const { code } = lower(
      'export const C = () => <HStack style={{ WebkitTextFillColor: "red" }} />;'
    );
    expect(code).toContain('data-mincho-layout="HStack"');
    expect(code).toContain("WebkitTextFillColor");
  });

  it.each([
    "padding: 0",
    'position: "static"',
    'overflow: "visible"',
    'boxSizing: "border-box"'
  ])("rejects owned styles matching runtime defaults: %s", (style) => {
    expect(() =>
      lower(`export const C = () => <Box style={{ ${style} }} />;`)
    ).toThrow("E_LAYOUT_CAPABILITY");
  });

  it.each(["undefined", "p.padding"])(
    "keeps runtime validation for possibly undefined owned styles: %s",
    (value) => {
      const { code, result } = lower(
        `export const C = (p) => <Box style={{ padding: ${value} }} />;`
      );
      expect(code).toContain("<Box");
      expect(result[1]).not.toContain("compileLayoutClass");
    }
  );

  it.each(["gap={p.gap}", "{...p}", "debugLayout", "as={Custom}"])(
    "keeps runtime style validation independent of attribute order with %s",
    (runtimeAttribute) => {
      for (const attributes of [
        `style={{ width: 10 }} ${runtimeAttribute}`,
        `${runtimeAttribute} style={{ width: 10 }}`
      ]) {
        const { code, result } = lower(
          `export const C = (p) => <HStack ${attributes} />;`
        );
        expect(code).toContain("<HStack");
        expect(result[1]).not.toContain("compileLayoutClass");
      }
    }
  );

  it("keeps Layout components and CSS generation disabled with styledComponents false", () => {
    const { code, result } = lower(
      'export const C = () => <Item as="button" width={80}>Save</Item>;',
      false
    );
    expect(code).toContain('<Item as="button"');
    expect(code).not.toContain("layout.css");
    expect(result[1]).not.toContain("compileLayoutClass");
  });

  it("is off unless enabled", () => {
    const { code } = babelTransform(
      header + `export const C = () => <HStack gap={8} />;`
    );
    expect(code).toContain("<HStack gap={8} />");
  });
});
