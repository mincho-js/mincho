import {
  clipPathFromPath,
  createSquircleMask,
  getSquircleGeometry,
  getSquircleMask
} from "@mincho-js/css/squircle/core";
import { observeBorderBox } from "./resize-pool.js";
import type { BorderBox } from "./resize-pool.js";
import { retainSquircleRule, shapeProbe, squircleClass } from "./rules.js";

export interface MaskConfig {
  radius: number;
  smoothing: number;
  cacheMask: boolean;
  observe: boolean;
  /** The clip-path value React rendered inline, if any. */
  clip: string | undefined;
  /** The rounded fallback React rendered inline. */
  borderRadius: number;
}

/** Read per attachment so iframes and test doubles answer for themselves. */
function supportsShape(node: HTMLElement): boolean {
  return (
    node.ownerDocument.defaultView?.CSS?.supports?.("clip-path", shapeProbe) ??
    false
  );
}

/**
 * Only committed props reach this controller; resizes never update React state.
 * Observed boxes share a class rule when it is available. Measured paths
 * override it when the box clamps the geometry, shape() is unsupported, or
 * stylesheet installation fails (for example under CSP).
 */
export function createMaskController(initial: MaskConfig) {
  let config = initial;
  let node: HTMLElement | null = null;
  let release: (() => void) | undefined;
  let releaseRule: (() => void) | undefined;
  let ruleClass: string | undefined;
  let shape = false;
  let lastSize: BorderBox | undefined;
  // Undefined: the DOM holds what React rendered.
  let lastClip: string | undefined;
  let lastRadius: string | undefined;
  let attachment = 0;

  function set(name: string, value: string | undefined) {
    if (value === undefined) node!.style.removeProperty(name);
    else node!.style.setProperty(name, value);
  }

  function write(clip: string | undefined, radius: string | undefined) {
    if (clip !== lastClip) set("clip-path", clip ?? config.clip);
    if (radius !== lastRadius)
      set("border-radius", radius ?? `${config.borderRadius}px`);
    lastClip = clip;
    lastRadius = radius;
  }

  function apply(box: BorderBox) {
    if (!node) return;
    lastSize = box;
    const options = {
      ...box,
      radius: config.radius,
      smoothing: config.smoothing
    };
    if (releaseRule) {
      const g = getSquircleGeometry(options);
      // The class rule's shape() is exact here. No path is built.
      if (g.radius === config.radius && g.smoothing === config.smoothing) {
        write(undefined, "0px");
        return;
      }
    }
    const asset = (config.cacheMask ? getSquircleMask : createSquircleMask)(
      options
    );
    if (asset) write(clipPathFromPath(asset.path), "0px");
    else write("none", `${config.radius}px`);
  }

  // Retain the new rule before releasing the old one, so a shared rule is
  // never deleted and reinserted in between.
  function syncRule() {
    const next =
      node && config.observe && shape
        ? squircleClass(config.radius, config.smoothing)
        : undefined;
    if (next === ruleClass) return;
    const previous = releaseRule;
    releaseRule =
      node && next
        ? retainSquircleRule(node, config.radius, config.smoothing)
        : undefined;
    ruleClass = next;
    previous?.();
  }

  function stop() {
    release?.();
    release = undefined;
    if (node) write(undefined, undefined);
    lastSize = lastClip = lastRadius = undefined;
  }

  function refresh() {
    syncRule();
    if (!node || !config.observe) {
      stop();
      return;
    }
    if (!release) release = observeBorderBox(node, apply);
    if (lastSize) apply(lastSize);
    else
      write(releaseRule ? undefined : "none", releaseRule ? "0px" : undefined);
  }

  function detach() {
    stop();
    releaseRule?.();
    releaseRule = ruleClass = undefined;
  }

  return {
    ref(next: HTMLElement | null) {
      detach();
      node = next;
      const version = ++attachment;
      if (node && node.namespaceURI !== "http://www.w3.org/1999/xhtml")
        throw new TypeError(
          "SquircleMask as must forward a ref to one HTML element."
        );
      shape = node ? supportsShape(node) : false;
      refresh();
      return () => {
        if (version !== attachment) return;
        detach();
        node = null;
      };
    },
    configure(next: MaskConfig) {
      // React rewrote clip-path during this commit only if its value changed.
      if (next.clip !== config.clip) lastClip = undefined;
      if (next.borderRadius !== config.borderRadius) lastRadius = undefined;
      config = next;
      refresh();
    },
    dispose: detach
  };
}
