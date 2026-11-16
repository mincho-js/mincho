import { rules } from "@mincho-js/preset-tailwind";

const parent = rules({
  base: { px: 2 },
  variants: { size: { large: { py: 3 } } }
});

export const coLocatedButton = rules.extends(parent, {
  base: { bg: "blue-500" },
  variants: { tone: { soft: { text: "blue-700" } } }
});

export const coLocatedRecipes = rules.multiple({
  label: { base: { p: 2 } },
  badge: { variants: { tone: { quiet: { bg: "blue-100" } } } }
});
