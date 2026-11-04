import { afterEach, beforeEach, expect, it } from "vitest";
import {
  mockAdapter,
  removeAdapter,
  setAdapter
} from "@vanilla-extract/css/adapter";
import { endFileScope, setFileScope } from "@vanilla-extract/css/fileScope";
import { squircle } from "./index.js";
import { getSquircleStyle } from "./styles.js";

const output: unknown[] = [];
beforeEach(() => {
  output.length = 0;
  setAdapter({ ...mockAdapter, appendCss: (rule) => output.push(rule) });
  setFileScope("avatar.css.ts", "squircle-test");
});
afterEach(() => {
  endFileScope();
  removeAdapter();
});

it("extracts the fixed clip and dimensions into a class", () => {
  const options = { width: 80, height: 80, radius: 20 };
  const className = squircle(options);
  expect(className).toEqual(expect.any(String));
  expect(output).toEqual([
    expect.objectContaining({
      selector: className,
      rule: getSquircleStyle(options)
    })
  ]);
  expect(getSquircleStyle(options).clipPath).toMatch(/^path\("M/);
});

it("rejects invalid inputs before registering CSS", () => {
  expect(() => squircle({ width: Infinity, height: 100 })).toThrow(RangeError);
  expect(output).toEqual([]);
});
