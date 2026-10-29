import type { Ref, RefCallback } from "react";

/** Attaches a ref and returns how to detach it, honoring React 19 cleanups. */
export function attachRef<T>(ref: Ref<T> | undefined, node: T): () => void {
  if (typeof ref === "function") {
    const cleanup = ref(node);
    return typeof cleanup === "function" ? cleanup : () => ref(null);
  }
  if (ref) (ref as { current: T | null }).current = node;
  return () => {
    if (ref) (ref as { current: T | null }).current = null;
  };
}

/** One ref when possible; otherwise a callback that attaches both. */
export function mergeRefs<T>(
  first: Ref<T> | undefined,
  second: Ref<T> | undefined
): Ref<T> | undefined {
  if (!second) return first;
  if (!first) return second;
  // React 19 calls the returned cleanup; earlier versions call with null.
  let detach: Array<() => void> | undefined;
  const release = () => {
    detach?.forEach((cleanup) => cleanup());
    detach = undefined;
  };
  const callback: RefCallback<T> = (node) => {
    release();
    if (node === null) return;
    detach = [attachRef(first, node), attachRef(second, node)];
    return release;
  };
  return callback;
}
