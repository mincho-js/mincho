import { fail, layoutStaticAttribute } from "@mincho-js/css/layout/core";
import { mainSize, normalizeBox } from "@mincho-js/css/layout/core";
import { nativeItems } from "@mincho-js/css/layout/core";
import type {
  NormalizedBox,
  NormalizedStack
} from "@mincho-js/css/layout/core";
import type { ItemRequirements, LayoutItem } from "@mincho-js/css/layout/core";

/** What development diagnostics read from a parent Stack. */
export interface StackContextValue {
  stack: NormalizedStack;
  root: HTMLElement | null;
  /** Layout elements whose parent context is this Stack. */
  members: Set<HTMLElement>;
}

export interface Registration {
  props: ItemRequirements;
  parent: StackContextValue | null;
  kind: string;
}

export const registrations = new WeakMap<HTMLElement, Registration>();
export const stackContexts = new WeakMap<HTMLElement, StackContextValue>();

type LayoutInput = Pick<Registration, "props" | "kind">;
const compiledInputs = new WeakMap<
  HTMLElement,
  { serialized: string; input: LayoutInput }
>();

/** Compiled roots can enter a runtime Stack through another component. */
function layoutInput(node: HTMLElement): LayoutInput | undefined {
  const registration = registrations.get(node);
  if (registration) return registration;
  const serialized = node.getAttribute(layoutStaticAttribute);
  const kind = node.getAttribute("data-mincho-layout");
  if (serialized === null || kind === null) {
    compiledInputs.delete(node);
    return undefined;
  }
  const cached = compiledInputs.get(node);
  if (cached?.serialized === serialized && cached.input.kind === kind)
    return cached.input;
  let props: unknown;
  try {
    props = JSON.parse(serialized);
  } catch {
    fail("E_LAYOUT_CAPABILITY", "Invalid compiled Layout metadata.");
  }
  if (props === null || typeof props !== "object" || Array.isArray(props))
    fail("E_LAYOUT_CAPABILITY", "Compiled Layout metadata must contain props.");
  const input = { props: props as ItemRequirements, kind };
  compiledInputs.set(node, { serialized, input });
  return input;
}

const relationKeys = [
  "gapBefore",
  "gapAfter",
  "breakBefore",
  "breakAfter"
] as const;
const marginKeys = [
  "marginInlineStart",
  "marginInlineEnd",
  "marginBlockStart",
  "marginBlockEnd"
] as const;
const kebab = (key: string) =>
  key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function isHtml(node: Element): node is HTMLElement {
  return node.namespaceURI === "http://www.w3.org/1999/xhtml";
}

export function validateSizingDependency(
  node: HTMLElement,
  box: NormalizedBox
) {
  if (box.position === "absolute") return;
  const parent = node.parentElement && layoutInput(node.parentElement);
  if (!parent) return;
  const parentBox = normalizeBox(parent.props);
  for (const dimension of ["width", "height"] as const) {
    if (parentBox[dimension].kind !== "content") continue;
    if (box[dimension].kind === "percent") {
      fail(
        "E_PERCENT_DEPENDENCY",
        `${dimension} percentage depends on a hugging parent.`
      );
    }
    // Cross stretch inside a Stack fills a line, not a natural-flow region.
    if (parent.kind === "Box" || parent.kind === "Item") {
      if (box[dimension].kind === "stretch")
        fail(
          "E_LAYOUT_CAPABILITY",
          `Natural-flow ${dimension} stretch needs an independently definite parent.`
        );
    }
  }
}

export function validateInsets(node: HTMLElement, box: NormalizedBox) {
  const computed = node.ownerDocument.defaultView!.getComputedStyle(node);
  const horizontal =
    parseFloat(computed.paddingLeft) +
    parseFloat(computed.paddingRight) +
    parseFloat(computed.borderLeftWidth) +
    parseFloat(computed.borderRightWidth);
  const vertical =
    parseFloat(computed.paddingTop) +
    parseFloat(computed.paddingBottom) +
    parseFloat(computed.borderTopWidth) +
    parseFloat(computed.borderBottomWidth);
  if (horizontal > box.maxWidth || vertical > box.maxHeight) {
    fail("E_INVALID_BOUNDS", "Padding and border exceed the maximum size.");
  }
}

/**
 * Development diagnostics for the actual direct DOM children. Styles come from
 * render and the relation stylesheet; this only checks them, including that
 * the stylesheet resolved each fixed space as the canonical model expects.
 */
export function validateLayout(context: StackContextValue) {
  const { root, stack } = context;
  if (!root) return undefined;
  const view = root.ownerDocument.defaultView;
  if (!view) fail("E_UNSUPPORTED_DOM_CHILD", "Stack needs a browser document.");
  if (view.getComputedStyle(root).display === "none") return undefined;
  diagnoseRoot(context, root, view);
  const flow: HTMLElement[] = [];
  let excluded = false;
  for (const element of Array.from(root.children)) {
    if (!isHtml(element))
      fail("E_UNSUPPORTED_DOM_CHILD", "Wrap non-HTML direct children in Item.");
    const computed = view.getComputedStyle(element);
    if (computed.display === "none") continue;
    if (
      computed.display === "contents" ||
      computed.cssFloat !== "none" ||
      computed.order !== "0"
    ) {
      fail(
        "E_UNSUPPORTED_DOM_CHILD",
        "display:contents, float and reordered children cannot define canonical item adjacency."
      );
    }
    if (computed.position === "absolute" || computed.position === "fixed") {
      excluded = true;
      const registration = layoutInput(element);
      if (registration && registration.props.position !== "absolute") {
        fail(
          "E_INVALID_PLACEMENT",
          "External CSS moved a flow layout item out of flow."
        );
      }
      continue;
    }
    flow.push(element);
  }
  const items: LayoutItem[] = flow.map((element, index) => ({
    id: String(index),
    props: layoutInput(element)?.props
  }));
  const hasRelations = items.some((item) =>
    relationKeys.some((key) => item.props?.[key] !== undefined)
  );
  if (
    hasRelations &&
    (excluded ||
      Array.from(root.childNodes).some(
        (n) => n.nodeType === 3 && Boolean(n.textContent?.trim())
      ))
  ) {
    fail(
      "E_UNSUPPORTED_DOM_CHILD",
      "Item relations cannot mix direct text or out-of-flow siblings. Use a nested Box."
    );
  }
  const result = nativeItems(stack, items);
  diagnoseItems(stack, view, flow, items, result);
  for (const [index, element] of flow.entries()) {
    const computed = view.getComputedStyle(element);
    for (const key of marginKeys) {
      const expected = result.styles[index][key];
      if (typeof expected !== "number") continue;
      const actual = parseFloat(computed.getPropertyValue(kebab(key)));
      if (Math.abs(actual - expected) > 0.5)
        fail(
          "E_UNSUPPORTED_DOM_CHILD",
          "Fixed item spacing did not resolve as declared. Hide siblings with conditional rendering or the hidden attribute, not CSS, and keep the relation stylesheet loaded.",
          { itemId: String(index) }
        );
    }
  }
  return result;
}

function diagnoseRoot(
  context: StackContextValue,
  root: HTMLElement,
  view: Window
) {
  validateInsets(root, context.stack);
  const computedRoot = view.getComputedStyle(root);
  if (computedRoot.writingMode !== "horizontal-tb")
    fail("E_LAYOUT_CAPABILITY", "Only horizontal writing mode is supported.");
  if (
    !["flex", "inline-flex"].includes(computedRoot.display) ||
    computedRoot.flexDirection !==
      (context.stack.axis === "horizontal" ? "row" : "column")
  ) {
    fail(
      "E_LAYOUT_CAPABILITY",
      "External styles changed the Stack layout algorithm."
    );
  }
  for (const member of context.members) {
    if (member.parentElement !== root)
      fail(
        "E_INVALID_ITEM_PARENT",
        "A layout participant must be a direct DOM child of its Stack. Use a Box at intervening layout boundaries."
      );
  }
}

function diagnoseItems(
  stack: NormalizedStack,
  view: Window,
  flow: readonly HTMLElement[],
  items: readonly LayoutItem[],
  result: ReturnType<typeof nativeItems>
) {
  const hasRelations = items.some((item) =>
    relationKeys.some((key) => item.props?.[key] !== undefined)
  );
  const variableSpace = [...result.boundaries, ...result.edges].some(
    (entry) => entry.space.kind === "stretch"
  );
  const managedStretch = items.filter(
    (item) =>
      item.props && mainSize(normalizeBox(item.props), stack).kind === "stretch"
  );
  for (const [index, element] of flow.entries()) {
    const props = items[index].props;
    const computed = view.getComputedStyle(element);
    if (
      !props &&
      (managedStretch.length || variableSpace) &&
      Number(computed.flexGrow) > 0
    ) {
      fail(
        "E_LAYOUT_CAPABILITY",
        "Use Item for all competing stretch participants."
      );
    }
    if (!props && hasRelations) {
      const margins =
        stack.axis === "horizontal"
          ? [computed.marginLeft, computed.marginRight]
          : [computed.marginTop, computed.marginBottom];
      if (margins.some((value) => parseFloat(value) !== 0)) {
        fail(
          "E_LAYOUT_CAPABILITY",
          "External item margins conflict with canonical spacing. Wrap this element in Item."
        );
      }
    }
    if (!props) continue;
    const box = normalizeBox(props);
    const horizontalInset =
      parseFloat(computed.paddingLeft) +
      parseFloat(computed.paddingRight) +
      parseFloat(computed.borderLeftWidth) +
      parseFloat(computed.borderRightWidth);
    const verticalInset =
      parseFloat(computed.paddingTop) +
      parseFloat(computed.paddingBottom) +
      parseFloat(computed.borderTopWidth) +
      parseFloat(computed.borderBottomWidth);
    if (horizontalInset > box.maxWidth || verticalInset > box.maxHeight) {
      fail("E_INVALID_BOUNDS", "Padding and border exceed the maximum size.", {
        itemId: String(index)
      });
    }
    if (
      managedStretch.length > 1 &&
      mainSize(box, stack).kind === "stretch" &&
      (stack.axis === "horizontal" ? horizontalInset : verticalInset) > 0
    ) {
      fail(
        "E_LAYOUT_CAPABILITY",
        "Stretch ratios with padding/border insets require precision allocation."
      );
    }
  }
}

/**
 * Validates and reads geometry on demand. Stacks register their semantics only
 * in development. Values come from the browser, not a JS solver.
 */
export function inspectLayout(root: HTMLElement) {
  const context = stackContexts.get(root);
  const snapshot = context && validateLayout(context);
  if (!snapshot)
    fail(
      "E_LAYOUT_CAPABILITY",
      "The element is not a mounted, visible Stack in a development build."
    );
  const readStyle = (node: Element) => {
    const computed = node.ownerDocument.defaultView!.getComputedStyle(node);
    return Object.fromEntries(
      [
        "display",
        "position",
        "direction",
        "writing-mode",
        "box-sizing",
        "width",
        "height",
        "min-width",
        "max-width",
        "min-height",
        "max-height",
        "padding",
        "border-width",
        "margin",
        "flex-direction",
        "flex-wrap",
        "flex-grow",
        "flex-shrink",
        "gap",
        "justify-content",
        "align-items",
        "align-self",
        "align-content",
        "overflow",
        "transform"
      ].map((property) => [property, computed.getPropertyValue(property)])
    );
  };
  return {
    path: "native" as const,
    source: "browser" as const,
    container: root.getBoundingClientRect().toJSON(),
    computedStyle: readStyle(root),
    boundaries: snapshot.boundaries,
    edges: snapshot.edges,
    items: Array.from(root.children).map((node) => ({
      element: node,
      rect: node.getBoundingClientRect().toJSON(),
      computedStyle: readStyle(node)
    }))
  };
}
