import { describe, it, expect } from "vitest";
import { transformSync, types as t } from "@babel/core";
import type { PluginObj } from "@babel/core";
import { minchoBabelPlugin } from "../index.js";
import type { PluginOptions } from "../types.js";

function extract(source: string) {
  const options: PluginOptions = {
    result: ["", ""],
    optimize: { pureFunctions: false }
  };

  const result = transformSync(source, {
    filename: "extraction.ts",
    configFile: false,
    babelrc: false,
    plugins: [[minchoBabelPlugin(), options]]
  });

  const exports: string[] = [];
  const executable = transformSync(options.result[1], {
    configFile: false,
    babelrc: false,
    plugins: [
      (): PluginObj => ({
        visitor: {
          ImportDeclaration(path) {
            path.replaceWith(
              t.variableDeclaration(
                "const",
                path.node.specifiers.map((specifier) =>
                  t.variableDeclarator(specifier.local, t.identifier("cssStub"))
                )
              )
            );
          },

          ExportNamedDeclaration(path) {
            const declaration = path.node.declaration;
            if (!declaration)
              throw new Error("Expected an extracted declaration");

            exports.push(...Object.keys(t.getBindingIdentifiers(declaration)));
            path.replaceWith(declaration);
          }
        }
      })
    ]
  });

  const run = new Function(
    "cssStub",
    `${executable?.code}\nreturn [${exports.join(",")}];`
  );

  return {
    source: result?.code,
    sidecar: options.result[1],
    values: run((rule: unknown) => rule)
  };
}

describe("extracted lexical bindings", () => {
  it.each([
    "false ? size : 4",
    "true ? 4 : size",
    "4 || size",
    "4 ?? size",
    "(false && size) || 4",
    "({ value: false ? size : 4 }).value"
  ])("prunes unreachable parameter references from sidecars: %s", (value) => {
    const result = extract(`
      import { css } from '@mincho-js/css';
      function Component(size) { return css({ padding: ${value} }); }
    `);

    expect(result.values).toEqual([{ padding: 4 }]);
    expect(result.sidecar).not.toMatch(/\bsize\b/);
    expect(result.source).toContain("function Component(size)");
  });

  it("prunes only sidecar clones of shared declarations", () => {
    const result = extract(`
      import { css } from '@mincho-js/css';
      function Component(size) {
        const rule = { padding: false ? size : 4 };
        return { rule, className: css(rule) };
      }
    `);

    expect(result.values).toEqual([{ padding: 4 }]);
    expect(result.sidecar).not.toMatch(/\bsize\b/);
    expect(result.source).toContain("padding: false ? size : 4");
  });

  it("preserves logical expression values instead of returning references", () => {
    const result = extract(`
      import { css } from '@mincho-js/css';
      function Component(size) {
        const width = 4;
        return css({ padding: +(delete (width || size)) });
      }
    `);

    expect(result.values).toEqual([{ padding: 1 }]);
    expect(result.sidecar).not.toMatch(/\bsize\b/);
  });

  it.each([
    "true ? size : 4",
    "false ? 4 : size",
    "false || size",
    "null ?? size",
    "true && size",
    "size ? 4 : 8"
  ])("still rejects reachable parameter references: %s", (value) => {
    expect(() =>
      extract(`
        import { css } from '@mincho-js/css';
        function Component(size) { return css({ padding: ${value} }); }
      `)
    ).toThrow(/captures runtime binding size/);
  });

  it("preserves independently shadowed constants in source and sidecar", () => {
    const result = extract(`
      import { css } from '@mincho-js/css';
      const color = 'red';
      const red = css({ color });
      function Component() {
        const color = 'blue';
        return css({ color });
      }
      { const color = 'green'; css({ color }); }
    `);

    expect(result.values).toEqual([
      { color: "red" },
      { color: "blue" },
      { color: "green" }
    ]);
    expect(result.source?.match(/const color =/g)).toHaveLength(3);
  });

  it("keeps parameters and nested helper locals inside their function", () => {
    const result = extract(`
      import { css as makeCss } from '@mincho-js/css';
      function makeRule(color) {
        function read() { const suffix = ''; return color + suffix; }
        return { color: read() };
      }
      const red = makeCss(makeRule('red'));
    `);

    expect(result.values).toEqual([{ color: "red" }]);
    expect(result.sidecar.match(/function read/g)).toHaveLength(1);
    expect(result.sidecar.match(/const suffix/g)).toHaveLength(1);
  });

  it("extracts mutually recursive helpers once and permits finite calls", () => {
    const result = extract(`
      import { css } from '@mincho-js/css';
      function getColor() { return other(false); }
      function other(recurse) { return recurse ? getColor() : 'red'; }
      const first = css({ color: getColor() });
      const second = css({ color: other(false) });
    `);

    expect(result.values).toEqual([{ color: "red" }, { color: "red" }]);
    expect(result.sidecar.match(/function getColor/g)).toHaveLength(1);
    expect(result.sidecar.match(/function other/g)).toHaveLength(1);
  });

  it("renames conflicting helper declarations and their recursive references", () => {
    const result = extract(`
      import { css } from '@mincho-js/css';
      function getColor(n) { return n ? getColor(n - 1) : 'red'; }
      css({ color: getColor(1) });
      function Component() {
        function getColor(n) { return n ? getColor(n - 1) : 'blue'; }
        return css({ color: getColor(1) });
      }
    `);

    expect(result.values).toEqual([{ color: "red" }, { color: "blue" }]);
  });
});
