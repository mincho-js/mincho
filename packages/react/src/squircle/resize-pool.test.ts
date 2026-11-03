import { assert, it as test } from "vitest";
import { observeBorderBox } from "./resize-pool.js";

test("keeps independent subscriptions on the same element", () => {
  const { instances, element, entry } = environment();
  const node = element();
  let first = 0;
  let second = 0;
  const stopFirst = observeBorderBox(node, () => first++);
  const stopSecond = observeBorderBox(node, () => second++);
  instances[0].emit([entry(node)]);
  stopFirst();
  assert.equal(instances[0].targets.size, 1);
  instances[0].emit([entry(node, 220)]);
  assert.deepEqual([first, second], [1, 2]);
  stopSecond();
  assert.ok(instances[0].disconnected);
});

test("batches reads before listener writes and skips removed listeners", () => {
  const { instances, element, entry } = environment();
  const a = element();
  const b = element();
  const view = a.ownerDocument.defaultView!;
  const read = view.getComputedStyle;
  const events: string[] = [];
  view.getComputedStyle = (...args) => {
    events.push("read");
    return read(...args);
  };
  const stopA = observeBorderBox(a, () => {
    events.push("write");
    stopB();
  });
  const stopB = observeBorderBox(b, () => assert.fail("removed listener ran"));
  instances[0].emit([entry(a), entry(b)]);
  assert.deepEqual(events, ["read", "read", "write"]);
  stopA();
});

test("uses each document's observer and releases both independently", () => {
  const a = environment();
  const b = environment();
  const stopA = observeBorderBox(a.element(), () => {});
  const stopB = observeBorderBox(b.element(), () => {});
  assert.equal(a.instances.length, 1);
  assert.equal(b.instances.length, 1);
  stopA();
  assert.ok(a.instances[0].disconnected);
  assert.equal(b.instances[0].disconnected, false);
  stopB();
  assert.ok(b.instances[0].disconnected);
});

function environment() {
  const instances: MockObserver[] = [];
  class MockObserver {
    callback: ResizeObserverCallback;
    targets = new Set<Element>();
    disconnected = false;
    constructor(cb: ResizeObserverCallback) {
      this.callback = cb;
      instances.push(this);
    }
    observe(target: Element, options?: ResizeObserverOptions) {
      assert.equal(options?.box, "border-box");
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.disconnected = true;
      this.targets.clear();
    }
    emit(entries: object[]) {
      this.callback(
        entries as ResizeObserverEntry[],
        this as unknown as ResizeObserver
      );
    }
  }
  const style = {
    writingMode: "horizontal-tb",
    paddingLeft: "10px",
    paddingRight: "10px",
    paddingTop: "10px",
    paddingBottom: "10px",
    borderLeftWidth: "2px",
    borderRightWidth: "2px",
    borderTopWidth: "2px",
    borderBottomWidth: "2px"
  };
  const doc = {
    defaultView: { ResizeObserver: MockObserver, getComputedStyle: () => style }
  };
  const element = () => ({ ownerDocument: doc }) as unknown as HTMLElement;
  const entry = (target: HTMLElement, inlineSize = 200, blockSize = 100) => ({
    target,
    borderBoxSize: [{ inlineSize, blockSize }]
  });
  return { instances, style, element, entry };
}

test("multiple elements share one observer and last cleanup disconnects it", () => {
  const { instances, element } = environment();
  const stops = Array.from({ length: 100 }, () =>
    observeBorderBox(element(), () => {})
  );
  assert.equal(instances.length, 1);
  assert.equal(instances[0].targets.size, 100);
  for (const stop of stops) {
    stop();
    stop();
  }
  assert.equal(instances[0].targets.size, 0);
  assert.ok(instances[0].disconnected);
});
test("duplicate dimensions do not notify subscribers", () => {
  const { instances, element, entry } = environment();
  const el = element();
  let calls = 0;
  const stop = observeBorderBox(el, () => calls++);
  instances[0].emit([entry(el)]);
  instances[0].emit([entry(el)]);
  instances[0].emit([entry(el, 201)]);
  assert.equal(calls, 2);
  stop();
});
test("vertical writing mode converts logical sizes to physical border-box sizes", () => {
  const { instances, element, entry, style } = environment();
  const el = element();
  style.writingMode = "vertical-rl";
  let result: unknown;
  const stop = observeBorderBox(el, (box) => {
    result = box;
  });
  instances[0].emit([entry(el, 100, 200)]);
  assert.deepEqual(result, { width: 200, height: 100 });
  stop();
});
test("legacy fallback includes padding and border without a layout measurement API", () => {
  const { instances, element } = environment();
  const el = element();
  let result: unknown;
  const stop = observeBorderBox(el, (box) => {
    result = box;
  });
  instances[0].emit([{ target: el, contentRect: { width: 100, height: 80 } }]);
  assert.deepEqual(result, { width: 124, height: 104 });
  stop();
});
test("unsubscribe and resubscribe starts a fresh observer without a retained target", () => {
  const { instances, element } = environment();
  const el = element();
  const first = observeBorderBox(el, () => {});
  first();
  const second = observeBorderBox(el, () => {});
  assert.equal(instances.length, 2);
  assert.ok(instances[0].disconnected);
  second();
  assert.ok(instances[1].disconnected);
});
test("unavailable ResizeObserver leaves fallback intact and cleanup remains safe", () => {
  const el = { ownerDocument: { defaultView: {} } } as unknown as HTMLElement;
  const stop = observeBorderBox(el, () =>
    assert.fail("unexpected notification")
  );
  assert.doesNotThrow(stop);
});

test.each([false, true])(
  "uses delivered sizes without style reads (vertical: %s)",
  (vertical) => {
    const { instances, element } = environment();
    const el = element();
    el.ownerDocument.defaultView!.getComputedStyle = () =>
      assert.fail("unexpected style read");
    const sizes: unknown[] = [];
    const stop = observeBorderBox(el, (box) => sizes.push(box));
    for (const width of [240, 320.5]) {
      const contentWidth = width - 24;
      instances[0].emit([
        {
          target: el,
          borderBoxSize: [
            {
              inlineSize: vertical ? 140 : width,
              blockSize: vertical ? width : 140
            }
          ],
          contentBoxSize: [
            {
              inlineSize: vertical ? 116 : contentWidth,
              blockSize: vertical ? contentWidth : 116
            }
          ],
          contentRect: { width: contentWidth, height: 116 }
        }
      ]);
    }
    assert.deepEqual(sizes, [
      { width: 240, height: 140 },
      { width: 320.5, height: 140 }
    ]);
    stop();
  }
);

test("square border boxes need no orientation read", () => {
  const { instances, element, entry } = environment();
  const el = element();
  el.ownerDocument.defaultView!.getComputedStyle = () =>
    assert.fail("unexpected style read");
  let result: unknown;
  const stop = observeBorderBox(el, (box) => {
    result = box;
  });
  instances[0].emit([entry(el, 140, 140)]);
  assert.deepEqual(result, { width: 140, height: 140 });
  stop();
});

test("ambiguous square content follows writing-mode changes with asymmetric insets", () => {
  const { instances, element, entry, style } = environment();
  const el = element();
  const results: unknown[] = [];
  const stop = observeBorderBox(el, (box) => results.push(box));
  const report = {
    ...entry(el, 124, 140),
    contentBoxSize: [{ inlineSize: 100, blockSize: 100 }],
    contentRect: { width: 100, height: 100 }
  };
  style.writingMode = "vertical-rl";
  instances[0].emit([report]);
  style.writingMode = "horizontal-tb";
  instances[0].emit([report]);
  assert.deepEqual(results, [
    { width: 140, height: 124 },
    { width: 124, height: 140 }
  ]);
  stop();
});
