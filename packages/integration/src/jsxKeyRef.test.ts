import { describe, expect, it, vi } from "vitest";
import { transformSync } from "esbuild";
import * as jsxRuntime from "react/jsx-dev-runtime";
import { createElement, type ReactElement } from "react";
import { babelTransformSource } from "./babel.js";

async function compile(source: string, runtimeCodegen: boolean) {
  const transformed = await babelTransformSource({
    filename: "/jsx-key-ref.tsx",
    source,
    babel: {
      jsxCssProp: true,
      optimize: { pureFunctions: false, runtimeCodegen }
    }
  });
  const code = transformSync(transformed.code, {
    loader: "tsx",
    format: "cjs",
    jsx: "automatic",
    jsxDev: true,
    jsxImportSource: "react"
  }).code;
  const exports: {
    render?: (
      input: Record<string, unknown>
    ) => ReactElement<Record<string, unknown>>;
  } = {};
  const module = { exports };
  const cx = (...values: unknown[]) => values.filter(Boolean).join(" ");
  const sidecar = Object.create(null) as Record<string, unknown>;

  for (const match of transformed.code.matchAll(/\b([\w$]+) as ([\w$]+)\b/g)) {
    const name = match[1]!;
    sidecar[name] = name.endsWith("VarKey")
      ? "--width"
      : name.endsWith("Cx")
        ? cx
        : "class";
  }

  const modules: Record<string, unknown> = {
    "react/jsx-dev-runtime": jsxRuntime,
    react: { createElement },
    "@mincho-js/css/classname": { cx },
    "@mincho-js/transform-runtime": {
      vx: (value: unknown) => value
    }
  };

  new Function("require", "module", "exports", code)(
    (name: string) => {
      if (name.endsWith(".css.ts")) return sidecar;
      if (!(name in modules))
        throw new Error(`Unexpected test import: ${name}`);

      return modules[name];
    },
    module,
    exports
  );

  if (!module.exports.render) throw new Error("Missing render export");

  return module.exports.render;
}

describe.each([false, true])(
  "aggregated key/ref in React development (codegen=%s)",
  (runtimeCodegen) => {
    it.each([
      ["plain", 'key={input.key} ref={input.ref} {...input.props} css="class"'],
      [
        "dynamic",
        "key={input.key} ref={input.ref} {...input.props} css={{width: input.width}}"
      ],
      [
        "trailing",
        "css={{width: input.width}} {...input.props} key={input.key} ref={input.ref}"
      ]
    ])(
      "does not spread explicit key/ref again for %s aggregates",
      async (name, attributes) => {
        const render = await compile(
          `export const render = input => <div data-${name}-${runtimeCodegen} ${attributes} />;`,
          runtimeCodegen
        );
        const ref = { current: null };
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
          const element = render({
            key: "item",
            ref,
            width: 4,
            props: { title: "item" }
          });

          expect(element.key).toBe("item");
          expect(element.props.ref).toBe(ref);
          expect(element.props).not.toHaveProperty("css");
          expect(error).not.toHaveBeenCalled();
        } finally {
          error.mockRestore();
        }
      }
    );

    it.each([
      ["key", "key={input.key}"],
      ["ref", "ref={input.ref}"]
    ])(
      "retains the spread-only property when only %s is explicit",
      async (name, attribute) => {
        const render = await compile(
          `export const render = input => <div ${attribute} {...input.props} css={{width: input.width}} />;`,
          runtimeCodegen
        );
        const ref = { current: null };
        const error = vi.spyOn(console, "error").mockImplementation(() => {});

        try {
          const element = render({
            key: "item",
            ref,
            width: 4,
            props: name === "key" ? { ref } : { key: "item" }
          });

          expect(element.key).toBe("item");
          expect(element.props.ref).toBe(ref);
        } finally {
          error.mockRestore();
        }
      }
    );
  }
);
