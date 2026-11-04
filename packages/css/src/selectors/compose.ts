import type { Node, Selector as SelectorNode } from "postcss-selector-parser";
import {
  cloneNodes,
  compound,
  edgeNode,
  elementSelectors,
  groupSelectors,
  isPseudoElement,
  parse,
  parser,
  sameNode,
  stringify,
  validateElements
} from "./syntax.js";
import type { Selector } from "./types.js";

/** Copy both selectors so joining does not change another list combination. */
function join(
  left: SelectorNode,
  right: SelectorNode,
  combinator: string
): SelectorNode {
  const result = left.clone();
  if (combinator) result.append(parser.combinator({ value: combinator }));
  cloneNodes(right.nodes).forEach((node) => result.append(node));
  return result;
}

/** Negation and filtered positions must operate on the entire parent list. */
function requiresParentGroup(node: Node): boolean {
  for (let parent = node.parent; parent; parent = parent.parent)
    if (
      parent.type === "pseudo" &&
      /^:(not|nth-child|nth-last-child)$/i.test(parent.value)
    )
      return true;
  return false;
}

/** Preserve pseudo-element chains, but never turn them into element subjects. */
function validateNesting(selector: SelectorNode, relative = false): void {
  if (
    (!relative && edgeNode(selector, "start")?.type === "combinator") ||
    edgeNode(selector, "end")?.type === "combinator"
  )
    throw new TypeError("Expected a complete nesting selector");
  let pseudoElement = false;
  selector.walk((node) => {
    if (isPseudoElement(node)) {
      if (node.parent !== selector)
        throw new TypeError(
          "Pseudo-elements cannot be functional selector arguments"
        );
      pseudoElement = true;
    } else if (
      pseudoElement &&
      node.parent === selector &&
      node.type !== "pseudo" &&
      node.type !== "comment"
    )
      throw new TypeError("Only pseudo selectors can follow a pseudo-element");
  });
}

/** Descendant nesting, or substitution of actual & tokens (including in pseudos). */
export function nest(...selectors: Selector[]): Selector {
  if (!selectors.length)
    throw new TypeError("nest requires at least one selector");
  let parents = parse(selectors[0]);
  parents.forEach((selector) => validateNesting(selector));
  for (const value of selectors.slice(1)) {
    const next: SelectorNode[] = [];
    let groupedParents: SelectorNode[] | undefined;
    for (const child of parse(value)) {
      const nesting: Node[] = [];
      child.walkNesting((node) => {
        nesting.push(node);
      });
      if (!nesting.length) {
        for (const parent of parents)
          next.push(
            join(
              parent,
              child,
              edgeNode(child, "start")?.type === "combinator" ? "" : " "
            )
          );
        continue;
      }
      // Independent & references may match different members of a parent list.
      // :is() retains that meaning without an exponential Cartesian expansion.
      const candidates =
        parents.length > 1 &&
        (nesting.length > 1 || nesting.some(requiresParentGroup))
          ? (groupedParents ??= [groupSelectors(parents)])
          : parents;
      for (const parent of candidates) {
        const isCompound = compound(parent.nodes);
        const hasType = parent.nodes.some(
          (node) => node.type === "tag" || node.type === "universal"
        );
        let groupedNodes: SelectorNode["nodes"] | undefined;
        const result = child.clone();
        const references: Node[] = [];
        result.walkNesting((node) => {
          references.push(node);
        });
        for (const reference of references) {
          if (reference.next()?.type === "tag")
            throw new TypeError(
              "Identifier suffix nesting is not supported; use a complete selector"
            );
          const previous = reference.prev();
          const attachedType =
            previous && previous.type !== "combinator" && hasType;
          const nodes =
            isCompound && !attachedType
              ? parent.nodes
              : (groupedNodes ??= groupSelectors([parent]).nodes);
          reference.replaceWith(...cloneNodes(nodes));
        }
        next.push(result);
      }
    }
    next.forEach((selector) => validateNesting(selector));
    parents = next;
  }
  return stringify(parents);
}

export function child(parent: Selector, child: Selector): Selector {
  const parents = elementSelectors(parent, false, true);
  const children = elementSelectors(child);
  return stringify(
    parents.flatMap((left) => children.map((right) => join(left, right, " > ")))
  );
}

/** Validate and order tokens without mutating or cloning the input nodes. */
function mergeCompound(
  left: SelectorNode["nodes"],
  right: SelectorNode["nodes"]
): SelectorNode["nodes"] {
  const nodes = [...left, ...right];
  const types = nodes.filter(
    (node) => node.type === "tag" || node.type === "universal"
  );
  if (types.length > 1 && types.some((node) => !sameNode(node, types[0])))
    throw new TypeError(
      "Cannot append different type or namespace selectors into one compound; use unify()"
    );
  // Preserve chains already present in an operand, such as ::part(x)::before.
  // Joining separate pseudo-element subjects is not supported by append().
  if (left.some(isPseudoElement) && right.some(isPseudoElement))
    throw new TypeError("Cannot append separate pseudo-element chains");
  const pseudoIndex = nodes.findIndex(isPseudoElement);
  if (
    pseudoIndex >= 0 &&
    nodes
      .slice(pseudoIndex + 1)
      .some((node) => node.type !== "pseudo" && node.type !== "comment")
  )
    throw new TypeError("Only pseudo selectors can follow a pseudo-element");
  // A type selector must precede classes. Preserve pseudo-class attachment to
  // pseudo-elements, e.g. ::part(button):hover is not :hover::part(button).
  return [
    ...types.slice(0, 1),
    ...nodes.filter((node) => node.type !== "tag" && node.type !== "universal")
  ];
}

/** Copy shared inputs for list products, or consume a single owned pair. */
function appendPair(
  left: SelectorNode,
  right: SelectorNode,
  preserveInputs: boolean
): SelectorNode {
  if (
    edgeNode(left, "end")?.type === "combinator" ||
    edgeNode(right, "start")?.type === "combinator"
  )
    throw new TypeError("append requires adjoining compounds, not combinators");
  let splitLeft = left.nodes.length;
  while (splitLeft > 0 && left.nodes[splitLeft - 1].type !== "combinator")
    splitLeft--;
  const splitRight = right.nodes.findIndex(
    (node) => node.type === "combinator"
  );
  const endRight = splitRight < 0 ? right.nodes.length : splitRight;
  const joined = parser.selector({ value: "" });
  const nodes = [
    ...left.nodes.slice(0, splitLeft),
    ...mergeCompound(
      left.nodes.slice(splitLeft),
      right.nodes.slice(0, endRight)
    ),
    ...right.nodes.slice(endRight)
  ];
  const ownedNodes = preserveInputs ? cloneNodes(nodes) : nodes;
  ownedNodes.forEach((node) => joined.append(node));
  return joined;
}

/** Join the last compound of the left selector to the first of the right. */
export function append(...selectors: Selector[]): Selector {
  if (!selectors.length)
    throw new TypeError("append requires at least one selector");
  let result = parse(selectors[0]);
  for (const value of selectors.slice(1)) {
    const right = parse(value);
    const preserveInputs = result.length > 1 || right.length > 1;
    result = result.flatMap((left) =>
      right.map((member) => appendPair(left, member, preserveInputs))
    );
  }
  return stringify(result);
}

/** Matching intersection; complex selectors use standard CSS :is() predicates. */
export function unify(a: Selector, b: Selector): Selector {
  const left = elementSelectors(a);
  const right = elementSelectors(b);
  if (
    left.length === 1 &&
    right.length === 1 &&
    compound(left[0].nodes) &&
    compound(right[0].nodes)
  ) {
    const types = [...left[0].nodes, ...right[0].nodes].filter(
      (node) => node.type === "tag" || node.type === "universal"
    );
    if (types.length <= 1 || types.every((node) => sameNode(node, types[0])))
      return stringify([appendPair(left[0], right[0], false)]);
  }
  return `:is(${stringify(left)}):is(${stringify(right)})`;
}

/** Replace complete selector tokens, never text inside attribute/string values.
 * Targets/replacements are compounds. This is not Sass @extend weaving.
 */
export function replace(
  selector: Selector,
  target: Selector,
  replacement: Selector
): Selector {
  const targets = parse(target);
  let replacements = parse(replacement);
  if (
    targets.length !== 1 ||
    !compound(targets[0].nodes) ||
    replacements.some((value) => !compound(value.nodes))
  )
    throw new TypeError(
      "replace expects one compound target and compound replacements"
    );
  const introducesPseudoElement = replacements.some((value) => {
    let found = false;
    value.walkPseudos((node) => {
      if (isPseudoElement(node)) {
        found = true;
        return false;
      }
    });
    return found;
  });
  if (replacements.length > 1) {
    // Each occurrence can match any replacement, including mixed combinations.
    validateElements(replacements);
    replacements = [groupSelectors(replacements)];
  }
  const match = targets[0].nodes;
  const results: SelectorNode[] = [];
  for (const source of parse(selector)) {
    for (const substitution of replacements) {
      const result = source.clone();
      function visit(current: SelectorNode) {
        // Only selector-valued pseudos contain selector tokens; nth arithmetic
        // and :lang() arguments must never be interpreted as class/tag targets.
        for (const node of [...current.nodes]) {
          if (
            node.type === "pseudo" &&
            /^(:(is|where|not|has|host|host-context)|::slotted)$/i.test(
              node.value
            )
          )
            node.nodes.forEach(visit);
          if (
            node.type === "pseudo" &&
            /^:nth-(last-)?child$/i.test(node.value)
          ) {
            const first = node.nodes[0];
            const ofIndex =
              first?.nodes.findIndex(
                (token) =>
                  token.type === "tag" && token.value.toLowerCase() === "of"
              ) ?? -1;
            if (ofIndex >= 0) {
              const prefix = cloneNodes(first.nodes.slice(0, ofIndex + 2));
              const group = parser.selector({ value: "" });
              cloneNodes(first.nodes.slice(ofIndex + 2)).forEach((token) =>
                group.append(token)
              );
              visit(group);
              first.removeAll();
              [...prefix, ...cloneNodes(group.nodes)].forEach((token) =>
                first.append(token)
              );
              node.nodes.slice(1).forEach(visit);
            }
          }
        }
        for (let i = 0; i <= current.nodes.length - match.length; i++) {
          if (
            !match.every((node, offset) =>
              sameNode(node, current.nodes[i + offset])
            )
          )
            continue;
          const old = current.nodes.slice(i, i + match.length);
          old[0].replaceWith(...cloneNodes(substitution.nodes));
          old.slice(1).forEach((node) => node.remove());
          i += substitution.nodes.length - 1;
        }
        // Replacing a class with a type selector still requires valid type-first
        // ordering in its compound; never turn .a + button into .abutton.
        const nodes = [...current.nodes];
        current.removeAll();
        let pending: SelectorNode["nodes"] = [];
        const flush = () => {
          mergeCompound(pending, []).forEach((node) => current.append(node));
          pending = [];
        };
        for (const node of nodes) {
          if (node.type === "combinator") {
            flush();
            current.append(node);
          } else pending.push(node);
        }
        flush();
      }
      visit(result);
      if (introducesPseudoElement) validateNesting(result, true);
      results.push(result);
    }
  }
  return stringify(results);
}
