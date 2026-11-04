import {
  createElement,
  forwardRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState
} from "react";
import type {
  ComponentPropsWithRef,
  CSSProperties,
  ElementType,
  ReactElement,
  ReactNode
} from "react";
import {
  clipPathFromPath,
  createSquircleMask,
  finiteNonnegative,
  fixedSquircleSize,
  getSquircleMask,
  normalizeRadius,
  normalizeSmoothing,
  squircleMaskBase
} from "@mincho-js/css/squircle/core";
import type { WithAsProp } from "../index.js";
import { mergeRefs } from "../layout/refs.js";
import { createMaskController } from "./controller.js";
import { baseClass, squircleClass } from "./rules.js";

export interface SquircleMaskOptions {
  /** Fixed border-box CSS pixels. Omit to follow CSS/content sizing. */
  width?: number;
  height?: number;
  /** CSS px; defaults to 24, capped by the available corner space. */
  radius?: number;
  /** 0 is a circular corner, 1 is fully smoothed. Defaults to 0.6. */
  smoothing?: number;
  /** Reuse the bounded, shared path cache. Defaults to true. */
  cacheMask?: boolean;
}

export type SquircleMaskProps<T extends ElementType = "div"> =
  SquircleMaskOptions &
    WithAsProp<T> &
    Omit<ComponentPropsWithRef<T>, keyof SquircleMaskOptions | "as">;

type RenderProps = SquircleMaskOptions & {
  as?: ElementType;
  className?: string;
  children?: ReactNode;
  style?: CSSProperties;
};
const useClientLayoutEffect =
  typeof window === "undefined" ? useEffect : useLayoutEffect;

const SquircleMaskImpl = forwardRef<HTMLElement, RenderProps>(
  function SquircleMask(
    {
      as = "div",
      width,
      height,
      radius,
      smoothing,
      cacheMask = true,
      className,
      style,
      children,
      ...props
    },
    forwardedRef
  ) {
    const w =
      width === undefined ? undefined : finiteNonnegative(width, "width");
    const h =
      height === undefined ? undefined : finiteNonnegative(height, "height");
    const r = normalizeRadius(radius);
    const s = normalizeSmoothing(smoothing);
    const fixed = w !== undefined && h !== undefined;
    const cannotSmooth =
      (w !== undefined && w <= 2 * r) || (h !== undefined && h <= 2 * r);
    const observe = !fixed && !cannotSmooth && r > 0 && s > 0;
    // Fixed sizes resolve the exact path during render, so server output and
    // hydration agree, and no controller work or observation is needed.
    const fixedClip = useMemo(() => {
      if (!fixed) return undefined;
      const asset = (cacheMask ? getSquircleMask : createSquircleMask)({
        width: w,
        height: h,
        radius: r,
        smoothing: s
      });
      return asset ? clipPathFromPath(asset.path) : "none";
    }, [fixed, w, h, r, s, cacheMask]);
    // Responsive boxes paint a size-independent shape() from a shared class
    // rule; only boxes too small for the full smoothing budget need a measured
    // path. Unobserved boxes keep their declarations inline.
    const clip = observe ? undefined : (fixedClip ?? "none");
    const borderRadius =
      fixedClip === undefined || fixedClip === "none" ? r : 0;
    const [controller] = useState(() =>
      createMaskController({
        radius: r,
        smoothing: s,
        cacheMask,
        observe,
        clip,
        borderRadius
      })
    );
    const ref = useMemo(
      () => mergeRefs(controller.ref, forwardedRef),
      [controller, forwardedRef]
    );

    useClientLayoutEffect(() => {
      controller.configure({
        radius: r,
        smoothing: s,
        cacheMask,
        observe,
        clip,
        borderRadius
      });
    }, [controller, r, s, cacheMask, observe, clip, borderRadius]);
    useClientLayoutEffect(() => () => controller.dispose(), [controller]);

    // Sizing and the rounded fallback must work before hydration and even if
    // CSP blocks the shared stylesheet. The controller only changes clipping.
    const hostStyle = {
      ...squircleMaskBase,
      ...fixedSquircleSize(w, h),
      borderRadius,
      clipPath: clip
    };
    const hostClass = observe
      ? [baseClass, squircleClass(r, s), className].filter(Boolean).join(" ")
      : className;
    return createElement(
      as,
      {
        ...props,
        className: hostClass,
        ref,
        style: { ...style, ...hostStyle }
      },
      children
    );
  }
);

SquircleMaskImpl.displayName = "SquircleMask";
export const SquircleMask = SquircleMaskImpl as <T extends ElementType = "div">(
  props: SquircleMaskProps<T>
) => ReactElement | null;
