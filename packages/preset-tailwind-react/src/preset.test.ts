import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { $$styled } from "@mincho-js/react/runtime";
import {
  mockAdapter,
  removeAdapter,
  setAdapter
} from "@vanilla-extract/css/adapter";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { extractCalls } from "./config.js";
import * as jsxRuntime from "./jsx-runtime.js";
import * as jsxDevRuntime from "./jsx-dev-runtime.js";
import * as minchoJsxRuntime from "@mincho-js/react/jsx-runtime";
import * as minchoJsxDevRuntime from "@mincho-js/react/jsx-dev-runtime";

let preset: typeof import("./index.js");
let native: typeof import("@mincho-js/preset-tailwind");

beforeAll(async () => {
  setAdapter(mockAdapter);
  setFileScope("preset-tailwind-react.css.ts", "@test/tailwind-react");

  try {
    preset = await import("./index.js");
    native = await import("@mincho-js/preset-tailwind");
  } finally {
    endFileScope();
    removeAdapter();
  }
});

beforeEach(() => {
  setAdapter(mockAdapter);
  setFileScope("component.css.ts", "@test/tailwind-react");
});

afterEach(() => {
  endFileScope();
  removeAdapter();
});

it("shares the native preset definition and theme", () => {
  for (const name of [
    "css",
    "rules",
    "cx",
    "preset",
    "themeClass",
    "vars",
    "contract"
  ] as const) {
    expect(preset[name]).toBe(native[name]);
  }

  const padded = preset.css({ p: 4 });
  const horizontal = preset.css({ px: 2 });

  expect(preset.cx(padded, horizontal)).toBe(
    preset.cx(preset.css({ py: 4 }), horizontal)
  );
});

it("serializes Tailwind styled variants to the existing React runtime", () => {
  const Badge = preset.styled.span({
    base: { px: 2, py: 1, rounded: "full", font: "medium" },
    variants: {
      tone: {
        info: { bg: "sky-100", text: "sky-900" },
        success: { bg: "emerald-100", text: "emerald-900" }
      }
    },
    defaultVariants: { tone: "info" }
  });
  const metadata = (
    Badge as typeof Badge & {
      __recipe__: {
        importPath: string;
        importName: string;
        args: Parameters<typeof $$styled>;
      };
    }
  ).__recipe__;

  expect(metadata.importPath).toBe("@mincho-js/react/runtime");
  expect(metadata.importName).toBe("$$styled");

  const RuntimeBadge = $$styled(...metadata.args);
  const rendered = renderToStaticMarkup(
    createElement(RuntimeBadge, {
      tone: "success",
      id: "status",
      className: "external",
      children: "Saved"
    })
  );

  expect(rendered).toContain('<span id="status"');
  expect(rendered).toContain("external");
  expect(rendered).toContain(metadata.args[1]({ tone: "success" }));
  expect(metadata.args[1]({ tone: "success" })).not.toBe(
    metadata.args[1]({ tone: "info" })
  );
  expect(rendered).not.toContain("tone=");
  expect(rendered).not.toContain("css=");
  expect(rendered).toContain(">Saved</span>");
});

it("registers native factories and callable or tagged styled factories", () => {
  const calls = extractCalls["@mincho-js/preset-tailwind-react"];

  expect(calls).toEqual(
    expect.arrayContaining([
      "css",
      "rules",
      "rules.extends",
      "rules.multiple",
      "cx",
      "styled",
      "styled.button",
      "styled.svg"
    ])
  );
  expect(new Set(calls).size).toBe(calls.length);
  expect(extractCalls["@mincho-js/preset-tailwind"]).toContain(
    "rules.multiple"
  );
});

it("reuses the guarded JSX runtimes without loading a preset runtime engine", () => {
  expect(jsxRuntime.Fragment).toBe(minchoJsxRuntime.Fragment);
  expect(jsxRuntime.jsx).toBe(minchoJsxRuntime.jsx);
  expect(jsxRuntime.jsxs).toBe(minchoJsxRuntime.jsxs);
  expect(jsxDevRuntime.Fragment).toBe(minchoJsxDevRuntime.Fragment);
  expect(jsxDevRuntime.jsxDEV).toBe(minchoJsxDevRuntime.jsxDEV);
  expect(() => jsxRuntime.jsx("button", { css: { px: 3 } })).toThrow(
    /uncompiled|not compiled|compile/i
  );
});
