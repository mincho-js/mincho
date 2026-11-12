import { defineRules as defineReactRules } from "@mincho-js/react";
import * as tailwindDefinition from "@mincho-js/preset-tailwind";

export const button = (
  <button
    css={{
      bg: { base: "blue-500", _hover: "blue-700" },
      text: "white",
      font: "bold",
      py: 2,
      px: 3,
      rounded: true
    }}
  />
);

export const composed = (
  <div css={[{ p: 4 }, { px: 3, py: 2 }, { pl: 1 }, "rounded"]} />
);

const selectedRecipeClass: string = "selected-recipe-class";

export const recipe = <span css={selectedRecipeClass} />;

// @ts-expect-error The preset's font alias accepts declared family or weight tokens.
export const invalidToken = <button css={{ font: "missing-font-token" }} />;

// @ts-expect-error Unknown utility aliases are not valid CSS properties.
export const invalidAlias = <button css={{ paddingXTypo: 3 }} />;

const { styled } = defineReactRules(tailwindDefinition);
const Badge = styled.span({
  base: { px: 2, rounded: "full" },
  variants: {
    tone: { info: { bg: "sky-100" }, success: { bg: "emerald-100" } }
  },
  defaultVariants: { tone: "info" }
});

export const styledBadge = <Badge id="badge" tone="success" />;

// @ts-expect-error The styled component preserves the recipe's variant names.
export const invalidVariant = <Badge tone="missing" />;

// @ts-expect-error Styled recipes preserve the preset's token vocabulary.
styled.span({ base: { bg: "missing" } });
