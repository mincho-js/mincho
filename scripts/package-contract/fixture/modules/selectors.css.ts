import { css, globalCss, selectors } from "@mincho-js/css";

globalCss(
  selectors.children(
    ".list",
    ".item",
    selectors.all(selectors.countAtLeast(5), selectors.between(2, 4))
  ),
  { color: "tomato" }
);

export const button = css({
  selectors: {
    [selectors.is("&", ":hover", ":focus")]: { color: "blue" }
  }
});
