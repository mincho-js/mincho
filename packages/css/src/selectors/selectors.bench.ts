import { bench, describe } from "vitest";
import { selectors } from "./index.js";

const parents = Array.from({ length: 16 }, (_, i) => `.parent-${i}`).join(", ");
const alternatives = ".active, .busy, .disabled, .selected";
const condition = selectors.all(selectors.countAtLeast(3), selectors.first(2));

describe("selector construction", () => {
  bench("append two compounds", () => {
    selectors.append(".button", ".active");
  });
  bench("append 16 by 4 selector lists", () => {
    selectors.append(parents, alternatives);
  });
  bench("unify compatible compounds", () => {
    selectors.unify('.button:hover[data-state="ready"]', "button.primary");
  });
  bench("has a relative selector list", () => {
    selectors.has(".card", '> img[data-role="thumb"], + .promo:is(.a, .b)');
  });
  bench("nest repeated complex parent references", () => {
    selectors.nest(".scope > .item", "& + & + & + &");
  });
  bench("nest shared parent groups", () => {
    selectors.nest(parents, "& + &, :not(&), &:has(> &)");
  });
  bench("replace with a selector list", () => {
    selectors.replace(".old + .old:is(.old, .other)", ".old", alternatives);
  });
  bench("children with combined conditions", () => {
    selectors.children(".list", ".item, .other", condition);
  });
});
