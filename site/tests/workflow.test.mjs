import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { Button, mintTheme, peachTheme } from "../src/generated/workflow.mjs";

const css = await readFile(
  new URL("../src/generated/workflow.css", import.meta.url),
  "utf8"
);

test("the landing example emits both themes into static CSS", () => {
  assert.notEqual(mintTheme, peachTheme);
  for (const theme of [mintTheme, peachTheme])
    assert.ok(css.includes(`.${theme}`));
  for (const value of ["#e4e84e", "#eea080", "#d8efde", "#f9e0d2"])
    assert.ok(css.includes(value));
  assert.match(css, /padding-inline:\s*var\(--/);
  assert.match(css, /background-color:\s*var\(--/);
});

test("the compiled component selects variants and preserves cx composition and button props", () => {
  const selections = new Set();
  const onClick = () => {};
  for (const tone of ["accent", "soft"]) {
    for (const size of ["small", "large"]) {
      const element = Button({
        tone,
        size,
        className: "consumer-class",
        onClick,
        children: "Grow"
      });
      assert.equal(element.type, "button");
      assert.equal(element.props.onClick, onClick);
      assert.equal(element.props.children, "Grow");
      assert.ok(element.props.className.split(" ").includes("consumer-class"));
      selections.add(element.props.className);
      for (const name of element.props.className
        .split(" ")
        .filter((name) => name !== "consumer-class")) {
        assert.ok(
          css.includes(`.${name}`),
          `missing compiled styles for ${name}`
        );
      }
    }
  }
  assert.equal(selections.size, 4);
  assert.equal(
    Button({}).props.className,
    Button({ tone: "accent", size: "small" }).props.className
  );
});

test("the demo bundle ships no style compiler or CSS injection", async () => {
  const source = await readFile(
    new URL("../src/generated/workflow.mjs", import.meta.url),
    "utf8"
  );
  assert.doesNotMatch(
    source,
    /from ["']@mincho-js\/(?:css|esbuild|transform-to-vanilla)/
  );
  assert.doesNotMatch(
    source,
    /document\.createElement\(["']style|insertRule\(/
  );
});
