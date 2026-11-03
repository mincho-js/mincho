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
import {
  createMaskController,
  imageProperty,
  radiusProperty
} from "./controller.js";

export interface SquircleMaskOptions {
  /** Fixed border-box CSS pixels. Omit to follow CSS/content sizing. */
  width?: number;
  height?: number;
  /** CSS px; defaults to 24, capped by the available corner space. */
  radius?: number;
  /** 0 is a circular corner, 1 is fully smoothed. Defaults to 0.6. */
  smoothing?: number;
  /** Reuse the bounded, shared SVG cache. Defaults to true. */
  cacheMask?: boolean;
}

export type SquircleMaskProps<T extends ElementType = "div"> =
  SquircleMaskOptions &
    WithAsProp<T> &
    Omit<ComponentPropsWithRef<T>, keyof SquircleMaskOptions | "as">;

type RenderProps = SquircleMaskOptions & {
  as?: ElementType;
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
    // Keep the hydration fallback stable. After commit, the controller's live
    // fragment owns painting; slider updates need neither encoding nor rewriting
    // the long CSS image declaration.
    const [initialImage] = useState(() =>
      fixed
        ? ((cacheMask ? getSquircleMask : createSquircleMask)({
            width: w,
            height: h,
            radius: r,
            smoothing: s
          })?.image ?? "none")
        : "none"
    );
    const [controller] = useState(() =>
      createMaskController({
        radius: r,
        smoothing: s,
        cacheMask,
        observe,
        fixedSize: fixed ? { width: w, height: h } : undefined
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
        fixedSize: fixed ? { width: w, height: h } : undefined
      });
    }, [controller, r, s, cacheMask, observe, fixed, w, h]);
    useClientLayoutEffect(() => () => controller.dispose(), [controller]);

    const fallbackImage = fixed ? initialImage : "none";
    const image = `var(${imageProperty}, ${fallbackImage})`;
    const hostStyle = {
      ...style,
      ...squircleMaskBase,
      ...fixedSquircleSize(w, h),
      [imageProperty]: "initial",
      [radiusProperty]: "initial",
      borderRadius: `var(${radiusProperty}, ${fallbackImage === "none" ? r : 0}px)`,
      maskImage: image,
      WebkitMaskImage: image
    };
    return createElement(as, { ...props, ref, style: hostStyle }, children);
  }
);

SquircleMaskImpl.displayName = "SquircleMask";
export const SquircleMask = SquircleMaskImpl as <T extends ElementType = "div">(
  props: SquircleMaskProps<T>
) => ReactElement | null;
