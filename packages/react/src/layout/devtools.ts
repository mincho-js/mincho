/**
 * Development-only DOM diagnostics. The React renderer calls these only inside
 * `process.env.NODE_ENV !== "production"` branches, so production bundles can
 * drop this module.
 */
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import type { ReactElement, Ref, RefCallback } from "react";
import { fail } from "@mincho-js/css/layout/core";
import {
  registrations,
  stackContexts,
  validateInsets,
  validateLayout,
  validateSizingDependency
} from "./dom.js";
import type { Registration, StackContextValue } from "./dom.js";
import { checkParent } from "@mincho-js/css/layout/core";
import { attachRef } from "./refs.js";
import type { LayoutKind, LayoutProps } from "@mincho-js/css/layout/core";
import { normalizeBox } from "@mincho-js/css/layout/core";
import type {
  NormalizedBox,
  NormalizedStack
} from "@mincho-js/css/layout/core";
import type { NativeStyle } from "@mincho-js/css/layout/core";

/** Parent semantics for development checks; production renders no Provider. */
const LayoutParent = /* @__PURE__ */ createContext<StackContextValue | null>(
  null
);
const useCommitEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

export interface DevLayoutInput {
  kind: LayoutKind;
  props: LayoutProps & { className?: string };
  stack: NormalizedStack | undefined;
  box: NormalizedBox;
  style: NativeStyle;
  customRoot: boolean;
  ref: Ref<HTMLElement> | undefined;
}

/**
 * All development-only state of a layout element: parent checks, the
 * registration DOM diagnostics read, and a Stack's validation loop. Errors
 * after mounting are thrown to the nearest error boundary.
 */
export function useDevLayout(input: DevLayoutInput) {
  const { kind, props, stack, box, style, ref } = input;
  const parent = useContext(LayoutParent);
  const [error, setError] = useState<unknown>();
  if (error) throw error;
  checkParent(kind, props, box, stack, parent?.stack);
  // Children read only the Stack's layout semantics, so the context changes
  // only with them and memoized children are not re-rendered by decoration.
  const stackKey = stack
    ? JSON.stringify([
        stack.axis,
        stack.gap,
        stack.wrap,
        stack.lineGap,
        stack.align,
        stack.justify,
        stack.alignLines,
        stack.width,
        stack.height,
        stack.position,
        stack.minWidth,
        stack.minHeight,
        stack.maxWidth,
        stack.maxHeight
      ])
    : "";
  const context = useMemo<StackContextValue | null>(
    () => (stack ? { stack, root: null, members: new Set() } : null),
    [stackKey]
  );
  const root = useRef<HTMLElement | null>(null);
  const registration = useRef<Registration>({ props, parent, kind });
  const detachRef = useRef<(() => void) | undefined>(undefined);
  const devRef = useCallback<RefCallback<HTMLElement>>(
    (node) => {
      const previous = root.current;
      if (previous) {
        parent?.members.delete(previous);
        registrations.delete(previous);
        stackContexts.delete(previous);
        if (context) context.root = null;
      }
      root.current = null;
      if (node) {
        if (
          node.nodeType !== 1 ||
          node.namespaceURI !== "http://www.w3.org/1999/xhtml"
        )
          fail(
            "E_INVALID_LAYOUT_ROOT",
            "The ref must resolve to one HTML DOM root."
          );
        root.current = node;
        registration.current.parent = parent;
        registrations.set(node, registration.current);
        parent?.members.add(node);
        if (context) {
          context.root = node;
          stackContexts.set(node, context);
        }
        validateSizingDependency(
          node,
          normalizeBox(registration.current.props)
        );
      }
      detachRef.current?.();
      detachRef.current = node ? attachRef(ref, node) : undefined;
    },
    [parent, context, ref]
  );
  // The registration keeps the latest committed props for DOM diagnostics.
  useCommitEffect(() => {
    registration.current.props = props;
  });
  useCommitEffect(() => {
    diagnoseCommit({
      node: root.current,
      kind,
      box,
      style,
      forwardedClassName: input.customRoot
        ? (props.className ?? "")
        : undefined,
      parent
    });
  });
  useCommitEffect(() => {
    const node = root.current;
    if (!context || !node) return;
    let disposed = false;
    let queued = false;
    const refresh = () => {
      if (queued || disposed) return;
      queued = true;
      queueMicrotask(() => {
        queued = false;
        validate();
      });
    };
    const watcher = watchLayout(node, refresh);
    const validate = () => {
      if (disposed) return;
      try {
        watcher.sync();
        node.dataset.minchoLayoutState = validateLayout(context)
          ? "valid"
          : "hidden";
      } catch (reason) {
        node.dataset.minchoLayoutState = "error";
        setError(reason);
      }
    };
    validate();
    watcher.start();
    return () => {
      disposed = true;
      watcher.dispose();
    };
  }, [context]);
  return {
    ref: devRef,
    wrap: (element: ReactElement) =>
      createElement(LayoutParent.Provider, { value: context }, element)
  };
}

export interface CommitTarget {
  node: HTMLElement | null;
  kind: string;
  box: NormalizedBox;
  style: NativeStyle;
  /** Present for a custom `as` target, even when no class was supplied. */
  forwardedClassName?: string;
  parent: StackContextValue | null;
}

/** Checks what a committed layout root actually forwarded to the DOM. */
export function diagnoseCommit(target: CommitTarget) {
  const { node, kind, box, style, forwardedClassName, parent } = target;
  if (!node)
    fail(
      "E_INVALID_LAYOUT_ROOT",
      "The as target must forward ref, className, style and data attributes to its DOM root."
    );
  if (node.dataset.minchoLayout !== kind)
    fail(
      "E_INVALID_LAYOUT_ROOT",
      "The as target did not forward layout attributes."
    );
  validateInsets(node, box);
  for (const directChild of Array.from(node.children)) {
    const registration = registrations.get(directChild as HTMLElement);
    if (registration)
      validateSizingDependency(
        directChild as HTMLElement,
        normalizeBox(registration.props)
      );
  }
  if (forwardedClassName !== undefined) {
    const classes = forwardedClassName.split(/\s+/).filter(Boolean);
    if (classes.some((name) => !node.classList.contains(name)))
      fail("E_INVALID_LAYOUT_ROOT", "The as target did not forward className.");
    const probe = node.ownerDocument.createElement("div").style;
    for (const [key, value] of Object.entries(style)) {
      const cssValue =
        typeof value === "number" && !["flexGrow", "flexShrink"].includes(key)
          ? `${value}px`
          : String(value);
      if (key.startsWith("--")) probe.setProperty(key, cssValue);
      else (probe as unknown as Record<string, string>)[key] = cssValue;
    }
    for (const key of Object.keys(style)) {
      const property = key as keyof CSSStyleDeclaration;
      const actual = key.startsWith("--")
        ? node.style.getPropertyValue(key)
        : node.style[property];
      const expected = key.startsWith("--")
        ? probe.getPropertyValue(key)
        : probe[property];
      if (actual !== expected)
        fail(
          "E_INVALID_LAYOUT_ROOT",
          `The as target did not forward style.${key}.`
        );
    }
  }

  if (parent?.root && node.parentElement !== parent.root)
    fail(
      "E_INVALID_ITEM_PARENT",
      "Expected a direct child of the parent Stack DOM root."
    );
}

/**
 * Re-runs diagnostics when computed styles may have changed without React:
 * DOM mutations, media/container queries and ancestor classes. Child sizes are
 * observed as a signal for style changes, not for geometry.
 */
export function watchLayout(node: HTMLElement, refresh: () => void) {
  const view = node.ownerDocument.defaultView!;
  const observed = new Set<Element>();
  const resize = new view.ResizeObserver(refresh);
  const mutation = new view.MutationObserver(refresh);
  return {
    /** Tracks the current direct children; call before each validation. */
    sync() {
      const children = new Set(node.children);
      for (const child of observed)
        if (!children.has(child)) resize.unobserve(child);
      for (const child of children)
        if (!observed.has(child)) resize.observe(child);
      observed.clear();
      for (const child of children) observed.add(child);
    },
    /** Starts observing after the first validation has applied its writes. */
    start() {
      resize.observe(node);
      mutation.observe(node, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "class", "hidden", "dir"]
      });
      view.addEventListener("resize", refresh);
    },
    dispose() {
      mutation.disconnect();
      resize.disconnect();
      view.removeEventListener("resize", refresh);
    }
  };
}
