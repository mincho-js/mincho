/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { theme, defineRules } from "@mincho-js/css";
import {
  mockAdapter,
  setAdapter,
  removeAdapter
} from "@vanilla-extract/css/adapter";
import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";
import { defaultBreakpoints, themeSpec } from "@mincho-js/tailwind";

import { defaultTokens } from "./defaults.js";
import { animationFrames } from "./keyframes.js";

const source = readFileSync(join(__dirname, "__fixtures__/theme.css"), "utf8");
const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
const sourceValues = Object.fromEntries(
  Array.from(source.matchAll(/(--[\w-]+):\s*([^;]+);/g), ([, key, value]) => [
    key,
    normalize(value)
  ])
);

function resolve(value: string): string {
  return value.replace(
    /--theme\((--[\w-]+),\s*([^)]*)\)/g,
    (_, key: string, fallback: string) => resolve(sourceValues[key] ?? fallback)
  );
}

beforeEach(() => {
  setAdapter(mockAdapter);
  setFileScope("preset.css.ts", "@test/tailwind");
});

afterEach(() => {
  endFileScope();
  removeAdapter();
});

describe("Tailwind default preset", () => {
  it("preserves every original token, including legacy defaults and font pairs", () => {
    const flattened: Record<string, string> = {
      "--spacing": defaultTokens.spacing
    };
    const groups = {
      colors: "color",
      fonts: "font",
      fontWeights: "font-weight",
      letterSpacings: "tracking",
      lineHeights: "leading",
      radii: "radius",
      shadows: "shadow",
      insetShadows: "inset-shadow",
      dropShadows: "drop-shadow",
      textShadows: "text-shadow",
      easings: "ease",
      animations: "animate",
      blurs: "blur",
      perspectives: "perspective",
      aspectRatios: "aspect",
      containers: "container",
      maxWidths: "max-width"
    } as const;

    for (const [group, prefix] of Object.entries(groups)) {
      for (const [name, value] of Object.entries(
        defaultTokens[group as keyof typeof groups]
      )) {
        flattened[`--${prefix}${name === "DEFAULT" ? "" : `-${name}`}`] =
          Array.isArray(value) ? value.join(", ") : value;
      }
    }

    for (const [name, { size, lineHeight }] of Object.entries(
      defaultTokens.fontSizes
    )) {
      flattened[`--text-${name}`] = size;
      flattened[`--text-${name}--line-height`] = lineHeight;
    }

    for (const [name, value] of Object.entries(defaultBreakpoints))
      flattened[`--breakpoint-${name}`] = value;

    for (const [name, value] of Object.entries(defaultTokens.defaults))
      flattened[
        `--default-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`
      ] = value;

    expect(Object.keys(sourceValues)).toHaveLength(419);
    expect(flattened).toEqual(
      Object.fromEntries(
        Object.entries(sourceValues).map(([name, value]) => [
          name,
          resolve(value)
        ])
      )
    );
  });

  it("retains all original animation frames and easing declarations", () => {
    const expected = Object.fromEntries(
      Array.from(
        source.matchAll(/@keyframes (\w+) \{([\s\S]*?)\n {2}\}/g),
        ([, name, body]) => [
          name,
          Object.fromEntries(
            Array.from(
              body.matchAll(/([^{}]+)\{([^{}]+)\}/g),
              ([, frame, declarations]) => [
                normalize(frame),
                Object.fromEntries(
                  Array.from(
                    declarations.matchAll(/([\w-]+):\s*([^;]+);/g),
                    ([, property, value]) => [
                      property.replace(/-([a-z])/g, (_, letter: string) =>
                        letter.toUpperCase()
                      ),
                      property === "opacity" ? Number(value) : normalize(value)
                    ]
                  )
                )
              ]
            )
          )
        ]
      )
    );

    expect(animationFrames).toEqual(expected);
  });

  it("preserves Preflight browser fixes with evaluated defaults in an explicit layer", () => {
    const original = readFileSync(
      join(__dirname, "__fixtures__/preflight.css"),
      "utf8"
    );
    const actual = readFileSync(join(__dirname, "preflight.css"), "utf8");
    const expected = original.replace(
      /--theme\(\s*(--[\w-]+)\s*,[^)]*\)/g,
      (_, key: string) => resolve(sourceValues[key])
    );
    const body = actual
      .replace(/^\/\*![\s\S]*?\*\/\s*@layer mincho-tailwind-preflight\s*\{/, "")
      .replace(/\}\s*$/, "");

    // Formatting may choose double quotes for CSS strings; declarations match.
    expect(normalize(body.replace(/"([^"]*)"/g, "'$1'"))).toBe(
      normalize(expected)
    );
    expect(actual).not.toContain("--theme(");
    expect(actual).toContain("@layer mincho-tailwind-preflight");
  });

  it("implements a reusable native contract and maps the full palette", () => {
    const [original, vars, contract] = theme(defaultTokens);
    const [changed, changedVars] = theme.extends(contract, {
      ...defaultTokens,
      colors: { ...defaultTokens.colors, "sky-600": "rebeccapurple" }
    });
    const { css } = defineRules(themeSpec(vars));

    expect(changed).not.toBe(original);
    expect(changedVars).toEqual(vars);
    expect(
      css.raw({ bg: "olive-500", fontSize: "lg", shadow: "DEFAULT" })
    ).toEqual({
      backgroundColor: vars.colors["olive-500"],
      fontSize: vars.fontSizes.lg.size,
      lineHeight: vars.fontSizes.lg.lineHeight,
      boxShadow: vars.shadows.DEFAULT
    });
    expect(css.raw({ dropShadow: "DEFAULT" })).toEqual({
      filter: vars.dropShadows.DEFAULT.map(
        (value) => `drop-shadow(${value})`
      ).join(" ")
    });
  });
});
