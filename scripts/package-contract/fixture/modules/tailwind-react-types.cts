import { styled } from "@mincho-js/preset-tailwind-react";
import { extractCalls } from "@mincho-js/preset-tailwind-react/config";
import type { JSX } from "@mincho-js/preset-tailwind-react/jsx-runtime";
import type { JSX as DevJSX } from "@mincho-js/preset-tailwind-react/jsx-dev-runtime";

const calls: readonly string[] =
  extractCalls["@mincho-js/preset-tailwind-react"];
const production: JSX.IntrinsicElements["div"] = {
  css: {
    display: { base: "flex", _sm: "inline-flex" },
    bg: "blue-500",
    px: 3
  }
};
const development: DevJSX.IntrinsicElements["div"] = production;
const Badge = styled.span({ base: { text: "white", px: 2 } });
void [calls, development, Badge];
// @ts-expect-error The CommonJS declaration retains the preset vocabulary.
const invalid: JSX.IntrinsicElements["div"] = { css: { bg: "missing-token" } };
void invalid;
