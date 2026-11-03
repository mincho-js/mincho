export interface BorderBox {
  readonly width: number;
  readonly height: number;
}
type Listener = (box: BorderBox) => void;
interface Subscription {
  listener: Listener;
  width: number;
  height: number;
}
interface Pool {
  observer: ResizeObserver;
  subscriptions: Map<HTMLElement, Set<Subscription>>;
}

// One lazily created observer per Document, not one per component.
const pools = new WeakMap<Document, Pool>();

function firstBox(
  boxes: readonly ResizeObserverSize[] | ResizeObserverSize | undefined
): ResizeObserverSize | undefined {
  return (Array.isArray(boxes) ? boxes[0] : boxes) as
    ResizeObserverSize | undefined;
}

function readBorderBox(entry: ResizeObserverEntry, view: Window): BorderBox {
  // Current browsers expose a sequence. Accept older single-object exposure.
  const box = firstBox(entry.borderBoxSize);
  if (box) {
    if (box.inlineSize === box.blockSize)
      return { width: box.inlineSize, height: box.blockSize };
    // The entry already contains the content box in logical and physical axes.
    // A unique exact match determines orientation without a style/layout read.
    const content = firstBox(entry.contentBoxSize);
    const rect = entry.contentRect;
    let vertical: boolean | undefined;
    if (content && content.inlineSize !== content.blockSize && rect) {
      if (
        content.inlineSize === rect.width &&
        content.blockSize === rect.height
      )
        vertical = false;
      else if (
        content.inlineSize === rect.height &&
        content.blockSize === rect.width
      )
        vertical = true;
    }
    // Square/legacy/mismatched reports are ambiguous. Do not cache writingMode:
    // a media query can change it without a React prop update.
    vertical ??= /^(vertical|sideways)/.test(
      view.getComputedStyle(entry.target).writingMode
    );
    return vertical
      ? { width: box.blockSize, height: box.inlineSize }
      : { width: box.inlineSize, height: box.blockSize };
  }
  // Older API fallback: use delivered contentRect, not getBoundingClientRect.
  const style = view.getComputedStyle(entry.target);
  const px = (value: string) => Number.parseFloat(value) || 0;
  return {
    width:
      entry.contentRect.width +
      px(style.paddingLeft) +
      px(style.paddingRight) +
      px(style.borderLeftWidth) +
      px(style.borderRightWidth),
    height:
      entry.contentRect.height +
      px(style.paddingTop) +
      px(style.paddingBottom) +
      px(style.borderTopWidth) +
      px(style.borderBottomWidth)
  };
}

export function observeBorderBox(
  element: HTMLElement,
  listener: Listener
): () => void {
  const doc = element.ownerDocument;
  const view = doc.defaultView as (Window & typeof globalThis) | null;
  if (!view?.ResizeObserver) return () => {}; // Keep the CSS rounded fallback.
  let pool = pools.get(doc);
  if (!pool) {
    const subscriptions = new Map<HTMLElement, Set<Subscription>>();
    const observer = new view.ResizeObserver((entries) => {
      const pending: {
        target: HTMLElement;
        sub: Subscription;
        box: BorderBox;
      }[] = [];
      // All reads first, then all writes. A previous mask write must not cause
      // another element's computed-style read in this batch to flush styles.
      for (const entry of entries) {
        const target = entry.target as HTMLElement;
        const listeners = subscriptions.get(target);
        if (!listeners) continue;
        const box = readBorderBox(entry, view);
        for (const sub of listeners) {
          if (box.width === sub.width && box.height === sub.height) continue;
          sub.width = box.width;
          sub.height = box.height;
          pending.push({ target, sub, box });
        }
      }
      for (const { target, sub, box } of pending) {
        if (subscriptions.get(target)?.has(sub)) sub.listener(box);
      }
    });
    pool = { observer, subscriptions };
    pools.set(doc, pool);
  }
  const current = pool;
  const sub = { listener, width: NaN, height: NaN };
  let listeners = current.subscriptions.get(element);
  if (!listeners) {
    listeners = new Set();
    current.subscriptions.set(element, listeners);
    current.observer.observe(element, { box: "border-box" });
  }
  listeners.add(sub);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const listeners = current.subscriptions.get(element);
    if (!listeners?.delete(sub)) return;
    if (listeners.size === 0) {
      current.subscriptions.delete(element);
      current.observer.unobserve(element);
    }
    if (current.subscriptions.size === 0) {
      current.observer.disconnect();
      pools.delete(doc);
    }
  };
}
