import { style as css } from "@vanilla-extract/css";
import type { StyleRule } from "@vanilla-extract/css";
import { fail } from "./diagnostics.js";
import {
  nativeBox,
  nativeStack,
  normalizeBox,
  normalizeStack
} from "./normalize.js";
import { nativeItems } from "./relations.js";
import type {
  BoxOptions,
  HStackOptions,
  ItemOptions,
  NativeLayoutItem,
  StackOptions,
  VStackOptions
} from "./types.js";

export type * from "./types.js";
export type { LayoutKind, LayoutProps } from "./layout.js";
export { LayoutError } from "./diagnostics.js";
export { layoutCss } from "./stylesheet.js";

/** Build-time patterns. Call in a .css.ts file processed by Mincho. */
export function box(props: BoxOptions = {}, debugId?: string): string {
  return css(nativeBox(normalizeBox(props)) as unknown as StyleRule, debugId);
}

export function stack(props: StackOptions, debugId?: string): string {
  return css(
    nativeStack(normalizeStack(props)) as unknown as StyleRule,
    debugId
  );
}

export function hstack(props: HStackOptions = {}, debugId?: string): string {
  return stack({ ...props, axis: "horizontal" }, debugId);
}

export function vstack(props: VStackOptions = {}, debugId?: string): string {
  return stack({ ...props, axis: "vertical" }, debugId);
}

/** Standalone items cannot validate neighbors; use stackLayout for relations. */
export function item(
  props: ItemOptions,
  parent: StackOptions,
  debugId?: string
): string {
  if (
    [props.gapBefore, props.gapAfter, props.breakBefore, props.breakAfter].some(
      (v) => v !== undefined
    )
  ) {
    fail(
      "E_LAYOUT_CAPABILITY",
      "Use stackLayout or React Item to validate actual sibling relations."
    );
  }
  const style = nativeBox(normalizeBox(props), normalizeStack(parent));
  return css(style as unknown as StyleRule, debugId);
}

/** Static DOM topology: preserve item order/visibility or use the React entry. */
export function stackLayout(
  props: StackOptions,
  items: readonly NativeLayoutItem[],
  debugId?: string
) {
  const parent = normalizeStack(props);
  const result = nativeItems(parent, items);
  return {
    className: css(nativeStack(parent) as unknown as StyleRule, debugId),
    itemClassNames: Object.fromEntries(
      items.map((entry, i) => [
        entry.id,
        css(
          result.styles[i] as unknown as StyleRule,
          debugId ? `${debugId}_${entry.id}` : undefined
        )
      ])
    )
  };
}
