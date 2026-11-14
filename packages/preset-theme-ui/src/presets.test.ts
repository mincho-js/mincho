/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  beforeEach,
  afterEach,
  describe,
  it,
  expect,
  expectTypeOf
} from "vitest";
import { theme, defineRules } from "@mincho-js/css";
import {
  mockAdapter,
  setAdapter,
  removeAdapter
} from "@vanilla-extract/css/adapter";
import { setFileScope, endFileScope } from "@vanilla-extract/css/fileScope";
import { themeSpec, normalizeTheme } from "@mincho-js/theme-ui";

import type { BaseTokens, SystemTokens } from "@mincho-js/theme-ui";
import { base } from "./presets/base.js";
import { system } from "./presets/system.js";
import { dark } from "./presets/dark.js";

beforeEach(() => {
  setAdapter(mockAdapter);
  setFileScope("preset.css.ts", "@test/theme-ui");
});

afterEach(() => {
  endFileScope();
  removeAdapter();
});

describe("Theme UI presets", () => {
  it.each([
    ["base", base],
    ["system", system],
    ["dark", dark]
  ] as const)(
    "preserves %s tokens from the pinned upstream fixture",
    (name, preset) => {
      const reference = JSON.parse(
        readFileSync(join(__dirname, "__fixtures__", `${name}.json`), "utf8")
      ) as Record<string, Record<string, unknown>>;

      expect(preset).toEqual(reference);
    }
  );

  it("shares every contract variable across system modes without losing tokens", () => {
    const [className, vars, contract] = theme(normalizeTheme(system).tokens);
    const reference = JSON.parse(
      readFileSync(join(__dirname, "__fixtures__", "system.json"), "utf8")
    );

    for (const [name, tokens] of Object.entries(normalizeTheme(system).modes)) {
      expect(tokens.colors).toEqual({
        ...normalizeTheme(system).tokens.colors,
        ...reference.colors.modes[name]
      });

      const [modeClass, modeVars, modeContract] = theme.extends(
        contract,
        tokens
      );

      expect(modeClass).not.toBe(className);
      expect(modeVars).toEqual(vars);
      expect(Object.keys(modeContract.values)).toEqual(
        Object.keys(contract.values)
      );
    }
  });
});

// Checked by tsc as well as the runtime suite; no invalid call is executed.
function typeChecks() {
  theme(normalizeTheme(base).tokens satisfies BaseTokens);
  theme(normalizeTheme(system).tokens satisfies SystemTokens);
  theme(normalizeTheme(dark).tokens);

  // @ts-expect-error The base contract requires its upstream bold token.
  theme(normalizeTheme(system).tokens satisfies BaseTokens);
  // @ts-expect-error The dark preset uses purple instead of accent.
  theme(normalizeTheme(dark).tokens satisfies SystemTokens);

  const [, vars, contract] = theme(normalizeTheme(system).tokens);
  theme.extends(contract, normalizeTheme(system).modes.dark);

  const definition = defineRules(themeSpec(vars));
  definition.css({
    p: 2,
    mx: -2,
    fontWeight: "display",
    _sm: { color: "accent" }
  });
  definition.css((tokens) => {
    expectTypeOf(tokens.colors.primary).toEqualTypeOf<
      typeof vars.colors.primary
    >();
    return { color: "primary", _md: { p: 3 }, borderColor: "inherit" };
  });

  // @ts-expect-error Unknown token.
  definition.css({ color: "missing" });
  // @ts-expect-error Array scale bounds are retained as numeric keys.
  definition.css({ p: 99 });
  // @ts-expect-error Negative padding is not a spacing token.
  definition.css({ p: -2 });
  // @ts-expect-error Unknown condition.
  definition.rules({ base: { _huge: { color: "primary" } } });
}

void typeChecks;
