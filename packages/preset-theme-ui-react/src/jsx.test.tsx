import { defineRules } from "@mincho-js/css";
import { describe, expect, it } from "vitest";
import { createComponents, css, system, styled } from "./index.js";

// The function is typechecked without emitting component CSS at test runtime.
function jsxTypes() {
  const { Button, Heading, Box } = system.components({
    buttons: {
      primary: { bg: "primary", color: "background" },
      secondary: { variant: "buttons.primary", bg: "secondary" }
    },
    layout: { panel: { p: { base: 2, _sm: 3 }, color: "text" } }
  });

  <Button variant="secondary" css={{ px: 4, bg: "secondary" }} />;
  <Button variant="text.display" />;
  <Heading variant="display" as="h1" />;
  <Heading variant="styles.h1" />;
  <Box variant="layout.panel" as="section" aria-label="Example" />;
  <a css={{ color: "primary" }} href="/docs">
    Documentation
  </a>;

  // @ts-expect-error Unknown component variant.
  <Button variant="missing" />;
  // @ts-expect-error The root JSX contract retains exact system tokens.
  <Box css={{ color: "not-a-token" }} />;
  // @ts-expect-error Intrinsic element props remain checked.
  <Button href="/docs" />;
  // @ts-expect-error Unknown token in native component groups.
  system.components({ buttons: { invalid: { bg: "not-a-token" } } });
  // @ts-expect-error Native public conditions use objects rather than arrays.
  system.components({ text: { invalid: { fontSize: [2, 3] } } });

  const core = defineRules({ properties: { color: { brand: "purple" } } });
  const custom = createComponents(core, {
    text: { custom: { color: "brand" } }
  });
  <custom.Text variant="custom" />;
  // @ts-expect-error Custom definitions preserve their own token keys.
  createComponents(core, { text: { invalid: { color: "primary" } } });
  // @ts-expect-error Valid tokens do not permit unknown style properties.
  createComponents(core, { text: { invalid: { color: "brand", typo: 1 } } });
  // @ts-expect-error Custom definitions preserve their own variant keys.
  <custom.Text variant="display" />;

  const scalar = defineRules({
    properties: {
      padding: (value: number) => Number(value.toFixed(0)),
      margin: (value: { amount?: number }) => value.amount ?? 0
    }
  });
  createComponents(scalar, { layout: { valid: { padding: 2, margin: {} } } });
  // @ts-expect-error A scalar resolver cannot receive an empty condition object.
  createComponents(scalar, { layout: { invalid: { padding: {} } } });

  const Native = styled.button({ base: { color: "primary" } });
  <Native css={{ color: "secondary" }} />;
  css({ px: 3, color: { base: "text", _hover: "primary" } });
}

describe("scoped Theme UI JSX types", () => {
  it("keeps authoring in the typecheck", () =>
    expect(jsxTypes).toBeTypeOf("function"));
});
