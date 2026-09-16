import { recipe } from "@vanilla-extract/recipes";
import { create } from "./helper";

export const makeStyle = (rule: Parameters<typeof create>[0]) => create(rule);

export function makeRecipe(options: Parameters<typeof recipe>[0]) {
  return recipe(options);
}

export const localClassName = makeRecipe({ base: { color: "orchid" } })();
