import { layoutPropKeys, isLayoutOwnedStyle } from "@mincho-js/css/layout/core";
import { createElement, forwardRef, useMemo } from "react";
import type { CSSProperties, ElementType, ReactNode, Ref } from "react";
import { useDevLayout } from "./devtools.js";
import { fail } from "@mincho-js/css/layout/core";
import { resolveLayout } from "@mincho-js/css/layout/core";
import type { LayoutKind, LayoutProps } from "@mincho-js/css/layout/core";
import { mergeRefs } from "./refs.js";
import { ensureLayoutStylesheet } from "@mincho-js/css/layout/core";
import type {
  BoxOptions,
  HStackOptions,
  NativeStyle,
  ItemOptions,
  StackOptions,
  VStackOptions
} from "@mincho-js/css/layout/core";
import type { LayoutComponent } from "./react-types.js";

declare const process: { env: { NODE_ENV?: string } };

export type * from "./react-types.js";
export type * from "@mincho-js/css/layout/core";
export { LayoutError } from "@mincho-js/css/layout/core";
export { inspectLayout } from "./dom.js";
export { layoutCss } from "@mincho-js/css/layout/core";

/*
 * Production renders only: declarations come from props, and the shared
 * stylesheet applies them for the actual parent. Development additionally
 * runs `useDevLayout`. Each check reads `process.env.NODE_ENV` directly so
 * bundlers fold it and drop the development module, like React.
 */

type RenderProps = LayoutProps & {
  children?: ReactNode;
  as?: ElementType;
  debugLayout?: boolean;
  className?: string;
  style?: CSSProperties;
  [key: string]: unknown;
};

function mergeStyle(
  style: CSSProperties | undefined,
  native: NativeStyle
): CSSProperties {
  for (const [key, value] of Object.entries(style ?? {})) {
    if (value !== undefined && isLayoutOwnedStyle(key)) {
      fail(
        "E_LAYOUT_CAPABILITY",
        `style.${key} conflicts with layout semantics; use a layout prop.`
      );
    }
  }
  return { ...style, ...native };
}

function renderLayout(
  kind: LayoutKind,
  props: RenderProps,
  forwardedRef: Ref<HTMLElement>
) {
  // Always validate the actual values. JSON keys lose NaN/Infinity/undefined
  // and are more work than resolving these small declaration objects.
  const { stack, box, style } = resolveLayout(kind, props);
  const dev =
    process.env.NODE_ENV !== "production"
      ? useDevLayout({
          kind,
          props,
          stack,
          box,
          style,
          customRoot: props.as !== undefined && typeof props.as !== "string",
          ref: forwardedRef
        })
      : undefined;
  const hostStyle = mergeStyle(props.style, style);
  const targetRef = dev ? dev.ref : forwardedRef;
  const hostRef = useMemo(
    () =>
      mergeRefs((node: HTMLElement | null) => {
        if (node?.ownerDocument) ensureLayoutStylesheet(node.ownerDocument);
      }, targetRef),
    [targetRef]
  );
  const host: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props))
    if (
      !(layoutPropKeys.has(key) || ["as", "debugLayout"].includes(key)) &&
      key !== "children"
    )
      host[key] = value;
  host["data-mincho-layout"] = kind;
  host["data-mincho-layout-axis"] = stack?.axis;
  if (process.env.NODE_ENV !== "production")
    host["data-mincho-layout-state"] = stack ? "pending" : undefined;
  host["data-mincho-layout-debug"] = props.debugLayout ? "native" : undefined;
  host["data-mincho-layout-out"] = box.position === "absolute" ? "" : undefined;
  host.className = props.className;
  host.style = hostStyle;
  host.ref = hostRef;
  const element = createElement(props.as ?? "div", host, props.children);
  return dev ? dev.wrap(element) : element;
}

function component(kind: Parameters<typeof renderLayout>[0]) {
  const result = forwardRef<HTMLElement, RenderProps>((props, ref) =>
    renderLayout(kind, props, ref)
  );
  result.displayName = kind;
  return result;
}

export const Box = component("Box") as LayoutComponent<BoxOptions>;
export const Stack = component("Stack") as LayoutComponent<StackOptions>;
export const HStack = component("HStack") as LayoutComponent<HStackOptions>;
export const VStack = component("VStack") as LayoutComponent<VStackOptions>;
export const Item = component("Item") as LayoutComponent<ItemOptions>;
