import { describe, expect, expectTypeOf, it } from "vitest";
import * as nativeRuntime from "react/jsx-runtime";
import * as nativeDevRuntime from "react/jsx-dev-runtime";
import * as compiledRuntime from "./compiled-jsx-runtime.js";
import * as compiledDevRuntime from "./compiled-jsx-dev-runtime.js";
import type { JSX } from "./jsx-namespace.js";

describe("compiler-selected JSX runtimes", () => {
  it("reexports the native runtime functions and Fragment unchanged", () => {
    expect(compiledRuntime.jsx).toBe(nativeRuntime.jsx);
    expect(compiledRuntime.jsxs).toBe(nativeRuntime.jsxs);
    expect(compiledRuntime.Fragment).toBe(nativeRuntime.Fragment);
    expect(compiledDevRuntime.jsxDEV).toBe(nativeDevRuntime.jsxDEV);
    expect(compiledDevRuntime.Fragment).toBe(nativeDevRuntime.Fragment);
  });

  it("preserves the authoring JSX namespace in both runtime types", () => {
    expectTypeOf<compiledRuntime.JSX.IntrinsicElements>().toEqualTypeOf<JSX.IntrinsicElements>();
    expectTypeOf<compiledDevRuntime.JSX.IntrinsicElements>().toEqualTypeOf<JSX.IntrinsicElements>();
  });
});
