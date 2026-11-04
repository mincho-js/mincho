import { getSquircleShape } from "@mincho-js/css/squircle/core";

export const baseClass = "mincho-squircle";
export const shapeProbe =
  "shape(from 0 0, line to 100% 0, line to 0 100%, close)";

// Class-safe numbers: "20.5" becomes "20_5"; exponents keep their sign.
const ident = (n: number) => String(n).replace(/[^\w-]/g, "_");

/** One clip rule per corner, shared by all matching elements. */
export function squircleClass(radius: number, smoothing: number): string {
  return `${baseClass}-r${ident(radius)}-s${ident(smoothing)}`;
}

type Scope = Document | ShadowRoot;
interface Entry {
  readonly radius: number;
  readonly smoothing: number;
  count: number;
  rules: CSSRule[];
}
interface Sheet {
  readonly style: HTMLStyleElement;
  readonly entries: Map<string, Entry>;
  // Unused rules, oldest first. Remounts and slider sweeps reuse them instead
  // of invalidating every style in the scope twice.
  readonly idle: Set<string>;
}

const MAX_IDLE = 32;
const sheets = new WeakMap<Scope, Sheet>();

// Document rules do not reach shadow trees; each tree gets its own sheet.
function scopeOf(node: HTMLElement): Scope {
  const root = node.getRootNode();
  return root.nodeType === 9 || (root.nodeType === 11 && "host" in root)
    ? (root as Scope)
    : node.ownerDocument;
}

function insertEntry(css: CSSStyleSheet, cls: string, entry: Entry) {
  const shape = getSquircleShape(entry)!;
  try {
    const index = css.insertRule(
      `.${cls}{clip-path:${shape}}`,
      css.cssRules.length
    );
    const rule = css.cssRules[index] as CSSStyleRule;
    // A rule can parse successfully while its unsupported declaration is dropped.
    if (rule.style.getPropertyValue("clip-path")) entry.rules = [rule];
    else css.deleteRule(index);
  } catch {
    // Required clipping rules must not be reported as installed on failure.
    // The controller will keep rounded corners until it measures a path.
  }
}

function sheetFor(scope: Scope, doc: Document): Sheet {
  const existing = sheets.get(scope);
  // Recreate a sheet whose element was removed, keeping retained corners.
  if (existing?.style.getRootNode() === scope) return existing;
  const style = doc.createElement("style");
  style.setAttribute("data-mincho-squircle", "");
  (scope.nodeType === 9 ? (doc.head ?? doc.documentElement) : scope).append(
    style
  );
  const css = style.sheet;
  const sheet: Sheet = { style, entries: new Map(), idle: new Set() };
  for (const [cls, entry] of existing?.entries ?? []) {
    if (entry.count === 0) continue;
    entry.rules = [];
    if (css) insertEntry(css, cls, entry);
    sheet.entries.set(cls, entry);
  }
  // Cache a blocked style element too, avoiding another CSP violation for
  // every component in the same tree.
  sheets.set(scope, sheet);
  return sheet;
}

function remove(sheet: Sheet, cls: string) {
  const entry = sheet.entries.get(cls)!;
  sheet.entries.delete(cls);
  sheet.idle.delete(cls);
  const css = sheet.style.sheet;
  if (!css) return;
  for (const rule of entry.rules) {
    const index = Array.prototype.indexOf.call(css.cssRules, rule);
    if (index >= 0) css.deleteRule(index);
  }
}

function idle(sheet: Sheet, cls: string) {
  sheet.idle.add(cls);
  if (sheet.idle.size > MAX_IDLE)
    remove(sheet, sheet.idle.values().next().value!);
}

/** Retain an installed rule, or report that measured clipping is required. */
export function retainSquircleRule(
  node: HTMLElement,
  radius: number,
  smoothing: number
): (() => void) | undefined {
  const scope = scopeOf(node);
  const sheet = sheetFor(scope, node.ownerDocument);
  const css = sheet.style.sheet;
  if (!css) return undefined; // CSP can block the stylesheet entirely.
  const cls = squircleClass(radius, smoothing);
  let entry = sheet.entries.get(cls);
  if (!entry) {
    entry = { radius, smoothing, count: 0, rules: [] };
    insertEntry(css, cls, entry);
    sheet.entries.set(cls, entry);
  }
  if (entry.rules.length === 0) {
    idle(sheet, cls);
    return undefined;
  }
  entry.count++;
  sheet.idle.delete(cls);
  const retained = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--retained.count > 0) return;
    const current = sheets.get(scope);
    if (current?.entries.get(cls) !== retained) return;
    idle(current, cls);
  };
}
