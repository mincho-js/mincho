import { elementSelectors, selectorList, stringify } from "./syntax.js";
import type { Selector } from "./types.js";

/** Attach to every base subject, allowing relative lists only inside :has(). */
function attach(base: Selector, name: string, selectors: Selector[]): Selector {
  const parsed = selectorList(selectors, name === "has");
  if (name === "has") {
    for (const selector of parsed)
      selector.walkPseudos((node) => {
        if (node.value.toLowerCase() === ":has")
          throw new TypeError("CSS does not allow nested :has()");
      });
  }
  const list = stringify(parsed);
  return elementSelectors(base, false, true)
    .map((value) => `${value.toString()}:${name}(${list})`)
    .join(", ");
}

export function is(base: Selector, ...selectors: Selector[]): Selector {
  return attach(base, "is", selectors);
}

export function where(base: Selector, ...selectors: Selector[]): Selector {
  return attach(base, "where", selectors);
}

export function has(base: Selector, ...selectors: Selector[]): Selector {
  return attach(base, "has", selectors);
}

export function exclude(base: Selector, ...selectors: Selector[]): Selector {
  return attach(base, "not", selectors);
}
