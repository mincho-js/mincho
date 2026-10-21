import React, { createElement as h, memo, createRef } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { $$styled } from "@mincho-js/react/runtime";
import {
  createCompiledClassRuntimeFn,
  createClassRuntimeFn
} from "@mincho-js/css/rules/createClassRuntimeFn";

const config = () => ({
  defaultClassName: "base",
  defaultVariants: { size: "small" },
  variantClassNames: {
    size: { small: "small", large: "large" },
    tone: { quiet: "quiet", loud: "loud" }
  },
  compoundVariants: [[{ size: "large", tone: "loud" }, "compound"]]
});

const host = document.getElementById("root");
const root = createRoot(host);

const render = (tree) => flushSync(() => root.render(tree));

let calls = 0;
const recipe = createCompiledClassRuntimeFn(config());

const counted = (selection) => {
  calls++;

  return recipe(selection);
};

counted.variants = recipe.variants;

const Raw = $$styled("button", counted);
const Memo = memo(Raw);
const stableStyle = { color: "red" };

function sample(kind, profile, n = 200, updates = 100) {
  render(null);
  calls = 0;

  const Component = kind === "memo" ? Memo : Raw;

  const tree = (tick) =>
    h(
      "section",
      null,
      Array.from({ length: n }, (_, i) =>
        h(
          Component,
          {
            key: i,
            id: "item-" + i,
            size:
              profile === "changing-variant" && tick % 2 ? "large" : "small",
            tone: "quiet",
            ...(profile === "fresh-style"
              ? { style: { color: "red" } }
              : { style: stableStyle })
          },
          profile === "fresh-child" ? h("span", null, "item") : "item"
        )
      )
    );

  render(tree(0));

  const initialCalls = calls;
  const start = performance.now();

  for (let tick = 1; tick <= updates; tick++) render(tree(tick));

  const ms = performance.now() - start;

  return {
    kind,
    profile,
    ms,
    initialCalls,
    updateCalls: calls - initialCalls,
    domCount: host.querySelectorAll("button").length
  };
}

function correctness() {
  const mutable = config();
  const styles = createClassRuntimeFn(mutable);
  const Normal = $$styled("div", styles);
  const Cached = memo(Normal);

  function mutation(Component) {
    render(null);
    mutable.defaultClassName = "before";
    render(h(Component, { size: "small" }));
    mutable.defaultClassName = "after";
    render(h(Component, { size: "small" }));

    return host.firstElementChild.className;
  }

  const mutationResult = { normal: mutation(Normal), memo: mutation(Cached) };
  const first = createRef(),
    second = createRef();

  render(h(Memo, { ref: first, size: "small" }));

  const button = first.current?.tagName;
  render(h(Memo, { ref: second, size: "large", as: "a", href: "/target" }));

  return {
    mutationResult,
    refAndAs: {
      firstTag: button,
      firstReleased: first.current === null,
      secondTag: second.current?.tagName,
      href: second.current?.getAttribute("href"),
      className: second.current?.className
    }
  };
}

globalThis.probe = { sample, correctness, version: React.version };
