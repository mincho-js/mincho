import { css } from "@mincho-js/css";
import * as styles from "@vanilla-extract/css";
import { recipe as createRecipe } from "@vanilla-extract/recipes";
import * as atomic from "@vanilla-extract/sprinkles";
import { createMapValueFn } from "@vanilla-extract/sprinkles/createUtils";
import { assignInlineVars, setElementVars } from "@vanilla-extract/dynamic";

const reset = styles.globalLayer("reset");
const components = styles.layer("components");
styles.globalStyle("body", { "@layer": { [reset]: { margin: 0 } } });

const contract = styles.createThemeContract({ color: null });
const theme = styles.createTheme(contract, { color: "rebeccapurple" });
const [alternateTheme, alternateVars] = styles.createTheme({ color: "orange" });
const accent = styles.createVar();
const container = styles.createContainer();
const transition = styles.createViewTransition();
const animation = styles.keyframes({
  from: { opacity: 0 },
  to: { opacity: 1 }
});

styles.globalStyle("body", { color: contract.color });
styles.globalStyle("body", { color: alternateVars.color });

const mincho = css({ padding: "13px" });
const native = styles.style({
  "@layer": {
    [components]: {
      color: styles.fallbackVar(accent, contract.color),
      containerName: container,
      viewTransitionName: transition,
      animationName: animation
    }
  }
});

const properties = atomic.defineProperties({
  conditions: { mobile: {}, desktop: { "@media": "(min-width: 800px)" } },
  defaultCondition: "mobile",
  responsiveArray: ["mobile", "desktop"],
  properties: { display: ["flex", "grid"] }
});

const sprinkles = atomic.createSprinkles(properties);
const normalize = atomic.createNormalizeValueFn(properties);
const map = createMapValueFn(properties);
const legacy = atomic.createAtomsFn(
  atomic.createAtomicStyles({ properties: { padding: ["7px", "9px"] } })
);

const button = createRecipe({
  base: [mincho, native],
  variants: { tone: { quiet: { opacity: 0.5 }, loud: { opacity: 1 } } },
  defaultVariants: { tone: "quiet" }
});

export function render(
  tone: "quiet" | "loud",
  display: "flex" | "grid",
  color: string
) {
  return {
    className: styles.composeStyles(
      theme,
      alternateTheme,
      button({ tone }),
      sprinkles({ display }),
      legacy({ padding: "7px" })
    ),
    inline: assignInlineVars({ [accent]: color }),
    normalized: normalize([display, "grid"]),
    mapped: map([1, 2], (value) => value * 4),
    assigned: styles.assignVars(contract, { color }),
    fallback: styles.fallbackVar(accent, color)
  };
}

export function update(element: HTMLElement, color: string) {
  setElementVars(element, { [accent]: color });
}
