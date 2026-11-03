import { StrictMode, forwardRef, memo, useState } from "react";
import type { ComponentPropsWithRef, CSSProperties } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { SquircleMask } from "@mincho-js/react/squircle";
import type { SquircleMaskOptions } from "@mincho-js/react/squircle";

type Options = SquircleMaskOptions & {
  style?: CSSProperties;
  as?: "div" | "section";
};
let roots: Root[] = [];
let change: ((patch: Options) => void) | undefined;
let original: HTMLElement | null = null;
let renders = 0;
let created: string[] = [];
let events: string[] = [];
let reads = 0;
let encodes = 0;
const encode = window.encodeURIComponent;
window.encodeURIComponent = (value) => {
  if (String(value).startsWith("<svg ")) encodes++;
  return encode(value);
};
const active = new Set<Element>();
export const errors: string[] = [];
export let hydrated = false;

function track(view: Window & typeof globalThis, label: string) {
  const Native = view.ResizeObserver;
  const read = view.getComputedStyle.bind(view);
  view.getComputedStyle = (...args) => {
    reads++;
    return read(...args);
  };
  class Tracked extends Native {
    targets = new Set<Element>();
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      created.push(label);
    }
    observe(target: Element, options?: ResizeObserverOptions) {
      this.targets.add(target);
      active.add(target);
      super.observe(target, options);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
      active.delete(target);
      super.unobserve(target);
    }
    disconnect() {
      this.targets.forEach((target) => active.delete(target));
      this.targets.clear();
      super.disconnect();
    }
  }
  view.ResizeObserver = Tracked;
  return Tracked;
}
const Observer = track(window, "main");
export function observation(enabled: boolean) {
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: enabled ? Observer : undefined
  });
}

const Child = memo(function Child() {
  renders++;
  const [value, setValue] = useState("keep");
  return (
    <input
      id="input"
      aria-label="Content"
      value={value}
      onChange={(event) => setValue(event.target.value)}
    />
  );
});
const Host = forwardRef<HTMLDivElement, ComponentPropsWithRef<"div">>(
  (props, ref) => <div {...props} ref={ref} data-forwarded="yes" />
);
function ref(node: HTMLElement | null) {
  if (!node) {
    events.push("null");
    return;
  }
  original ??= node;
  events.push(`attach:${node.tagName}`);
  return () => {
    events.push(`cleanup:${node.tagName}`);
  };
}
function Scene({ initial, custom }: { initial: Options; custom?: boolean }) {
  const [options, setOptions] = useState(initial);
  change = (patch) => setOptions((previous) => ({ ...previous, ...patch }));
  return (
    <SquircleMask
      {...options}
      as={custom ? Host : options.as}
      id="mask"
      ref={ref}
    >
      <Child />
    </SquircleMask>
  );
}
export function unmount() {
  roots.forEach((root) => root.unmount());
  roots = [];
}
function reset() {
  unmount();
  document.body.innerHTML = "";
  errors.length = 0;
  hydrated = false;
  created = [];
  events = [];
  renders = reads = encodes = 0;
  original = null;
  change = undefined;
}
function container(doc = document) {
  const element = doc.createElement("div");
  doc.body.appendChild(element);
  return element;
}
export function mount(options: Options, strict = false, custom = false) {
  reset();
  const root = createRoot(container());
  roots.push(root);
  const scene = <Scene initial={options} custom={custom} />;
  flushSync(() =>
    root.render(strict ? <StrictMode>{scene}</StrictMode> : scene)
  );
}
export function update(options: Options) {
  flushSync(() => change?.(options));
}
export function snapshot() {
  return {
    created,
    events,
    renders,
    reads,
    encodes,
    active: active.size,
    sameHost: original === document.getElementById("mask")
  };
}
export function hydrate(html: string, options: Options) {
  reset();
  const host = container();
  host.innerHTML = html;
  roots.push(
    hydrateRoot(
      host,
      <SquircleMask
        id="mask"
        {...options}
        ref={() => {
          hydrated = true;
        }}
      >
        <input id="input" defaultValue="keep" />
      </SquircleMask>,
      {
        onRecoverableError(error) {
          errors.push(String(error));
        }
      }
    )
  );
}
export function mountFrame() {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  track(frame.contentWindow! as Window & typeof globalThis, "frame");
  const root = createRoot(container(frame.contentDocument!));
  roots.push(root);
  flushSync(() =>
    root.render(
      <SquircleMask
        id="frame-mask"
        radius={16}
        style={{ width: 200, height: 120, background: "tomato" }}
      />
    )
  );
}
export function mountShadow() {
  reset();
  const host = document.createElement("div");
  host.id = "shadow-host";
  document.body.appendChild(host);
  const root = createRoot(host.attachShadow({ mode: "open" }));
  roots.push(root);
  flushSync(() =>
    root.render(
      <SquircleMask
        id="mask"
        width={240}
        height={140}
        radius={40}
        style={{ background: "rgb(0, 170, 119)" }}
      />
    )
  );
}
export function nested() {
  reset();
  const root = createRoot(container());
  roots.push(root);
  flushSync(() =>
    root.render(
      <SquircleMask width={300} height={200} radius={32}>
        <SquircleMask
          id="mask"
          radius={20}
          style={{ width: 200, height: 120 }}
        />
      </SquircleMask>
    )
  );
  return getComputedStyle(document.getElementById("mask")!).maskImage;
}
