import {
  createSquircleMask,
  getSquircleMask
} from "@mincho-js/css/squircle/core";
import { observeBorderBox } from "./resize-pool.js";
import type { BorderBox } from "./resize-pool.js";
import { createLiveMask } from "./live-mask.js";

export const imageProperty = "--mincho-squircle-image";
export const radiusProperty = "--mincho-squircle-radius";

export interface MaskConfig {
  radius: number;
  smoothing: number;
  cacheMask: boolean;
  observe: boolean;
  fixedSize?: BorderBox;
}

/** Only committed props reach this controller; resizes never update React state. */
export function createMaskController(initial: MaskConfig) {
  let config = initial;
  let node: HTMLElement | null = null;
  let release: (() => void) | undefined;
  let mask: ReturnType<typeof createLiveMask> | undefined;
  let lastSize: BorderBox | undefined;
  let lastImage: string | undefined;
  let lastRadius: string | undefined;
  let attachment = 0;

  function apply(box: BorderBox) {
    if (!node) return;
    lastSize = box;
    const asset = (config.cacheMask ? getSquircleMask : createSquircleMask)({
      ...box,
      radius: config.radius,
      smoothing: config.smoothing
    });
    if (asset) {
      mask ??= createLiveMask(node);
      mask.update(asset);
    } else {
      mask?.dispose();
      mask = undefined;
    }
    const image = mask?.image ?? "none";
    const radius = asset ? "0px" : `${config.radius}px`;
    if (image !== lastImage) node.style.setProperty(imageProperty, image);
    if (radius !== lastRadius) node.style.setProperty(radiusProperty, radius);
    lastImage = image;
    lastRadius = radius;
  }

  function stop() {
    release?.();
    release = undefined;
    mask?.dispose();
    mask = undefined;
    // `initial` prevents inheritance from another SquircleMask. Removing these
    // properties would expose the parent's mask before the next observation.
    if (node && lastImage !== undefined) {
      node.style.setProperty(imageProperty, "initial");
      node.style.setProperty(radiusProperty, "initial");
    }
    lastSize = lastImage = lastRadius = undefined;
  }

  function refresh() {
    if (!node || (!config.observe && !config.fixedSize)) {
      stop();
      return;
    }
    if (config.fixedSize) {
      release?.();
      release = undefined;
      apply(config.fixedSize);
      return;
    }
    if (!release) release = observeBorderBox(node, apply);
    if (lastSize) apply(lastSize);
  }

  return {
    ref(next: HTMLElement | null) {
      stop();
      node = next;
      const version = ++attachment;
      if (node && node.namespaceURI !== "http://www.w3.org/1999/xhtml")
        throw new TypeError(
          "SquircleMask as must forward a ref to one HTML element."
        );
      refresh();
      return () => {
        if (version !== attachment) return;
        stop();
        node = null;
      };
    },
    configure(next: MaskConfig) {
      config = next;
      refresh();
    },
    dispose: stop
  };
}
