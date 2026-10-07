import { describe, expect, it } from "vitest";
import {
  canBypassJsxRuntimeGuards,
  hasExplicitJsxRuntimeImport,
  transformJsxRuntimeGuards
} from "./jsxRuntimeGuards.js";

const filename = "/fixture/component.tsx";

describe("automatic JSX guard proof", () => {
  it.each([
    `export const C = () => <div className="a"><span /></div>;`,
    `const { css, ...rest } = incoming; export const C = () => <div {...rest} />;`,
    `const { ['css']: ignored, className, ...rest } = { ...incoming }; const C = <div {...rest} className={className} />;`,
    `const props = { title: readTitle(), ['data-x']: 1 }; const C = <div {...props} />;`,
    `export const C = () => <div {...(flag ? { id: 'a' } : { id: 'b' })} />;`
  ])("proves absence of own css: %s", (source) => {
    expect(canBypassJsxRuntimeGuards(source, filename)).toBe(true);
  });

  it.each([
    `const C = <div css="uncompiled" />;`,
    `const C = <div {...incoming} />;`,
    `const props = { title: 'a' }; mutate(props); const C = <div {...props} />;`,
    `const props = { title: 'a' }; props.css = 'uncompiled'; const C = <div {...props} />;`,
    `const { css, ...rest } = incoming; const alias = rest; alias.css = 'uncompiled'; const C = <div {...rest} />;`,
    `const { title, ...rest } = incoming; const C = <div {...rest} />;`,
    `const { nested: { css }, ...rest } = incoming; const C = <div {...rest} />;`,
    `let { css, ...rest } = incoming; rest = incoming; const C = <div {...rest} />;`,
    `const { css, ...rest } = incoming; Object.defineProperty(rest, 'css', { value: 1 }); const C = <div {...rest} />;`,
    `const C = <div {...{ [key]: 1 }} />;`,
    `const C = <div {...{ get title() { return 1 } }} />;`,
    `const C = <div {...{ __proto__: incoming }} />;`,
    `const { css, ...rest } = incoming; eval('rest.css = 1'); const C = <div {...rest} />;`,
    `function render(eval, incoming) { const { css, ...rest } = incoming; eval('rest.css = 1'); return <div {...rest} />; }`,
    `import { jsx } from '@mincho-js/react/jsx-runtime'; const C = <div />;`,
    `const runtime = require('@mincho-js/react/jsx-runtime'); const C = <div />;`,
    `import Runtime = require('@mincho-js/react/jsx-runtime'); const C = <div />;`,
    `require('@mincho' + '-js/react/jsx-runtime'); const C = <div />;`,
    `import(runtimeSource); const C = <div />;`
  ])("retains guard when proof is unavailable: %s", (source) => {
    expect(canBypassJsxRuntimeGuards(source, filename)).toBe(false);
  });

  it("recognizes explicit dev runtime and fails closed on invalid syntax", () => {
    expect(
      hasExplicitJsxRuntimeImport(
        `import { jsxDEV } from '@mincho-js/react/jsx-dev-runtime'`,
        filename
      )
    ).toBe(true);
    expect(canBypassJsxRuntimeGuards(`const = ;`, filename)).toBe(false);
  });
});

describe("lowered JSX guard specialization", () => {
  it("splits safe and unsafe calls sharing an automatic import", () => {
    const result = transformJsxRuntimeGuards(
      `
      import { jsx as _jsx, jsxs as _jsxs } from '@mincho-js/react/jsx-runtime';
      export const safe = _jsx('div', { className: 'a' });
      export const unsafe = _jsx('div', { ...incoming });
      export const css = _jsxs('div', { css: 'uncompiled', children: [] });
    `,
      filename
    );

    expect(result?.code).toContain("@mincho-js/react/compiled-jsx-runtime");
    expect(result?.code).toContain("@mincho-js/react/jsx-runtime");
    expect(result?.code).toMatch(/safe = _minchoCompiledjsx\(/);
    expect(result?.code).toMatch(/unsafe = _jsx\(/);
    expect(result?.code).toMatch(/css = _jsxs\(/);
    expect(result?.map).not.toBeNull();
  });

  it("removes fully unused guarded imports and preserves Fragment", () => {
    const result = transformJsxRuntimeGuards(
      `
      import { jsx as _jsx, Fragment } from '@mincho-js/react/jsx-runtime';
      export const safe = _jsx(Fragment, { children: 'a' });
    `,
      filename
    );

    expect(result?.code).toContain("import { Fragment }");
    expect(result?.code).not.toContain("jsx as _jsx");
  });

  it("handles generated CommonJS namespace and zero sequence calls", () => {
    const result = transformJsxRuntimeGuards(
      `
      var runtime = require('@mincho-js/react/jsx-runtime');
      exports.safe = (0, runtime.jsx)('div', { className: 'a' });
    `,
      filename
    );

    expect(result?.code).toContain(
      'require("@mincho-js/react/compiled-jsx-runtime").jsx'
    );
    expect(result?.code).not.toContain("var runtime");
    expect(result?.code).not.toContain("import ");
  });

  it("handles a generated css-excluded rest snapshot", () => {
    const result = transformJsxRuntimeGuards(
      `
      import { jsx as _jsx } from '@mincho-js/react/jsx-runtime';
      const { css, className, ...rest } = incoming;
      export const safe = _jsx('div', { ...rest, className });
    `,
      filename
    );

    expect(result?.code).toContain("compiled-jsx-runtime");
    expect(result?.code).not.toContain("from '@mincho-js/react/jsx-runtime'");
  });

  it("preserves jsxDEV argument positions and the uncompiled css guard", () => {
    const result = transformJsxRuntimeGuards(
      `
      import { jsxDEV as _jsxDEV } from '@mincho-js/react/jsx-dev-runtime';
      export const safe = _jsxDEV('div', { className: 'a' }, void 0, false, source, self);
      export const unsafe = _jsxDEV('div', { css: 'a' }, void 0, false, source, self);
    `,
      filename
    );

    expect(result?.code).toContain("compiled-jsx-dev-runtime");
    expect(result?.code).toContain("void 0, false, source, self");
    expect(result?.code).toContain("unsafe = _jsxDEV");
  });

  it("retains escaped namespaces, arbitrary calls, and spread arguments", () => {
    for (const source of [
      `const runtime = require('@mincho-js/react/jsx-runtime'); mutate(runtime); exports.C = runtime.jsx('div', {});`,
      `import { jsx } from '@mincho-js/react/jsx-runtime'; jsx(...args);`,
      `import { jsx } from '@mincho-js/react/jsx-runtime'; jsx('div', props);`,
      `import { jsx } from '@mincho-js/react/jsx-runtime'; eval(code); jsx('div', {});`
    ])
      expect(transformJsxRuntimeGuards(source, filename)).toBeNull();
  });
});
