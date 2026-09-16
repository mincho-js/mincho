import { defineStyle, makeRecipe } from "./factory";
import { unrelated } from "./helper";

export { localClassName } from "./implementation";

export const className = defineStyle({ color: "tomato" });
const button = makeRecipe({
  base: className,
  variants: { tone: { quiet: { opacity: 0.5 }, loud: { opacity: 1 } } }
});

export const render = (tone: "quiet" | "loud") =>
  [unrelated, button({ tone })].join(" ");
