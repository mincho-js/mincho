import parser from "postcss-selector-parser";
import type { Node, Selector as SelectorNode } from "postcss-selector-parser";

import type { Selector } from "./types.js";

/** Parse a nonempty list, removing formatting without changing identifier text. */
export function parse(value: Selector): SelectorNode[] {
  if (typeof value !== "string" || /^[ \t\n\f\r]*$/.test(value))
    throw new TypeError("A non-empty CSS selector is required");
  const root = parser().astSync(value);
  if (
    ("trailingComma" in root && root.trailingComma) ||
    root.nodes.some(
      (selector) => !selector.nodes.some((node) => node.type !== "comment")
    )
  )
    throw new TypeError("Empty members of a selector list are not allowed");
  for (const selector of root.nodes) {
    selector.first.spaces.before = "";
    selector.last.spaces.after = "";
  }
  return root.nodes;
}

/** Serialize list members without trimming significant escaped whitespace. */
export function stringify(selectors: readonly SelectorNode[]): Selector {
  // parse() removes formatting via AST spaces. String.trim() would also remove
  // significant escaped whitespace at the end of an identifier (e.g. #name\ ).
  return selectors.map((selector) => selector.toString()).join(", ");
}

/** Include legacy single-colon pseudo-elements when validating element lists. */
export function isPseudoElement(node: Node): boolean {
  return (
    node.type === "pseudo" &&
    (/^::/.test(node.value) ||
      /^:(before|after|first-line|first-letter)$/i.test(node.value))
  );
}

/** Comments do not change whether a selector starts or ends in a combinator. */
export function edgeNode(
  selector: SelectorNode,
  edge: "start" | "end"
): Node | undefined {
  const step = edge === "start" ? 1 : -1;
  for (
    let i = edge === "start" ? 0 : selector.nodes.length - 1;
    i >= 0 && i < selector.nodes.length;
    i += step
  )
    if (selector.nodes[i].type !== "comment") return selector.nodes[i];
}

/** Functional selector lists accept elements, not pseudo-elements. */
export function elementSelectors(
  value: Selector,
  relative = false,
  nesting = false
): SelectorNode[] {
  const selectors = parse(value);
  validateElements(selectors, relative, nesting);
  return selectors;
}

/** Reuse parsed arguments when validation is followed by a transformation. */
export function validateElements(
  selectors: readonly SelectorNode[],
  relative = false,
  nesting = false
): void {
  for (const selector of selectors) {
    if (
      (!relative && edgeNode(selector, "start")?.type === "combinator") ||
      edgeNode(selector, "end")?.type === "combinator"
    )
      throw new TypeError("Expected a complete element selector");
    selector.walk((node) => {
      if (isPseudoElement(node) || (!nesting && node.type === "nesting"))
        throw new TypeError(
          "Pseudo-elements and unresolved nesting cannot be used in this selector list"
        );
    });
  }
}

/** Validate and flatten selector arguments for a functional pseudo-class. */
export function selectorList(
  values: readonly Selector[],
  relative = false
): SelectorNode[] {
  if (!values.length) throw new TypeError("At least one selector is required");
  return values.flatMap((value) => elementSelectors(value, relative));
}

/** Build :is() without serializing and reparsing its already parsed members. */
export function groupSelectors(
  selectors: readonly SelectorNode[]
): SelectorNode {
  const group = parser.pseudo({ value: ":is", nodes: [] });
  selectors.forEach((selector, index) => {
    const member = selector.clone();
    // Match stringify() list separators without changing significant escapes.
    if (index) {
      const first = member.first;
      first.spaces.before = ` ${first.rawSpaceBefore}`;
      // A raw override is only needed if comments already override this space.
      if (first.rawSpaceBefore !== first.spaces.before)
        first.rawSpaceBefore = first.spaces.before;
    }
    group.append(member);
  });
  const result = parser.selector({ value: "" });
  result.append(group);
  return result;
}

export function cloneNodes(
  nodes: SelectorNode["nodes"]
): SelectorNode["nodes"] {
  return nodes.map((node) => node.clone());
}

export function compound(nodes: readonly Node[]): boolean {
  return nodes.every((node) => node.type !== "combinator");
}

/** Compare tokens without confusing class prefixes, escapes or attribute values. */
export function sameNode(a: Node, b: Node): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "class" || a.type === "id" || a.type === "nesting")
    return a.value === b.value;
  const left = a.clone();
  const right = b.clone();
  left.rawSpaceBefore = left.rawSpaceAfter = "";
  right.rawSpaceBefore = right.rawSpaceAfter = "";
  return left.toString() === right.toString();
}

export { parser };
