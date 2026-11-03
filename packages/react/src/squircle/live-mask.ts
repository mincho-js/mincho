import type { SquircleMaskAsset } from "@mincho-js/css/squircle/core";

const namespace = "http://www.w3.org/2000/svg";
type Root = Document | ShadowRoot;
interface Pool {
  svg: SVGSVGElement;
  defs: SVGDefsElement;
  count: number;
}
const pools = new WeakMap<Root, Pool>();
let nextId = 0;

/** Keep one resource URL while updating the path; no image fetch/decode on resize. */
export function createLiveMask(element: HTMLElement) {
  const doc = element.ownerDocument;
  const tree = element.getRootNode();
  const root: Root =
    tree.nodeType === 11 && "host" in tree ? (tree as ShadowRoot) : doc;
  let pool = pools.get(root);
  if (!pool) {
    const svg = doc.createElementNS(namespace, "svg");
    // A nonzero SVG viewport keeps fragment resources usable in Chromium.
    svg.setAttribute("width", "1");
    svg.setAttribute("height", "1");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("data-mincho-squircle-resources", "");
    Object.assign(svg.style, {
      position: "absolute",
      top: "0px",
      left: "0px",
      width: "1px",
      height: "1px",
      overflow: "hidden",
      pointerEvents: "none"
    });
    const defs = doc.createElementNS(namespace, "defs");
    svg.appendChild(defs);
    (root === doc ? (doc.body ?? doc.documentElement) : root).appendChild(svg);
    pool = { svg, defs, count: 0 };
    pools.set(root, pool);
  }
  const current = pool;
  const mask = doc.createElementNS(namespace, "mask");
  let id: string;
  do {
    id = `mincho-squircle-${++nextId}`;
  } while (root.getElementById(id));
  mask.id = id;
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  mask.setAttribute("maskContentUnits", "userSpaceOnUse");
  mask.style.maskType = "alpha";
  mask.setAttribute("x", "0");
  mask.setAttribute("y", "0");
  const path = doc.createElementNS(namespace, "path");
  // Presentation attributes would lose to ordinary global `path` selectors.
  path.style.fill = "white";
  mask.appendChild(path);
  current.defs.appendChild(mask);
  current.count++;
  let previous: SquircleMaskAsset | undefined;
  let disposed = false;
  return {
    image: `url("#${id}")`,
    update(asset: SquircleMaskAsset) {
      if (previous?.geometry.width !== asset.geometry.width)
        mask.setAttribute("width", String(asset.geometry.width));
      if (previous?.geometry.height !== asset.geometry.height)
        mask.setAttribute("height", String(asset.geometry.height));
      if (previous?.path !== asset.path) path.setAttribute("d", asset.path);
      previous = asset;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mask.remove();
      if (--current.count === 0) {
        current.svg.remove();
        pools.delete(root);
      }
    }
  };
}
