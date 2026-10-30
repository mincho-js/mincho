import {
  Component,
  StrictMode,
  createRef,
  forwardRef,
  memo,
  useState,
  useImperativeHandle
} from "react";
import type { HTMLAttributes, ReactNode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import {
  Box,
  HStack,
  Item,
  Stack,
  VStack,
  inspectLayout
} from "@mincho-js/react/layout";

export const errors: string[] = [];
export const events: string[] = [];
export const externalRef = createRef<HTMLButtonElement>();
let dispose: (() => void) | undefined;
let change: (() => void) | undefined;

class Boundary extends Component<{ children: ReactNode }, { error?: string }> {
  state: { error?: string } = {};
  static getDerivedStateFromError(error: Error) {
    return { error: error.message };
  }
  componentDidCatch(error: Error) {
    errors.push(error.message);
  }
  render() {
    return this.state.error ? (
      <output id="error">{this.state.error}</output>
    ) : (
      this.props.children
    );
  }
}

const Forwarded = forwardRef<
  HTMLButtonElement,
  HTMLAttributes<HTMLButtonElement>
>(({ onClick, ...props }, ref) => (
  <button
    {...props}
    ref={ref}
    onClick={(event) => {
      events.push("target");
      onClick?.(event);
    }}
  />
));
const MissingRef = (props: HTMLAttributes<HTMLButtonElement>) => (
  <button className={props.className}>Missing ref</button>
);
const MissingStyle = forwardRef<
  HTMLButtonElement,
  HTMLAttributes<HTMLButtonElement>
>(({ style, ...props }, ref) => (
  <button {...props} ref={ref} style={{ color: style?.color }} />
));
const MissingVariables = forwardRef<
  HTMLButtonElement,
  HTMLAttributes<HTMLButtonElement>
>(({ style, ...props }, ref) => (
  <button
    {...props}
    ref={ref}
    style={Object.fromEntries(
      Object.entries(style ?? {}).filter(([key]) => !key.startsWith("--"))
    )}
  />
));

const ImperativeRoot = forwardRef<object, HTMLAttributes<HTMLDivElement>>(
  (props, ref) => {
    useImperativeHandle(ref, () => ({}), []);
    return <div {...props} />;
  }
);

function Dynamic({ axis = false }: { axis?: boolean }) {
  const [changed, setChanged] = useState(false);
  change = () => setChanged((value) => !value);
  const Maybe = () =>
    changed && !axis ? null : (
      <button style={{ width: 100, height: 30 }}>First</button>
    );
  return (
    <Stack
      id="stack"
      width={400}
      height={200}
      gap={12}
      axis={axis && changed ? "vertical" : "horizontal"}
    >
      <Maybe />
      <Item id="b" width={100} height={30} gapBefore={20}>
        B
      </Item>
    </Stack>
  );
}

let memoRenders = 0;
export const renders = () => memoRenders;
// A custom as target renders when its Item renders.
const Counted = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  (props, ref) => {
    memoRenders++;
    return <div {...props} ref={ref} />;
  }
);
const MemoChild = memo(function MemoChild() {
  return <Item as={Counted} id="a" width={100} height={20} />;
});
function Decorated() {
  const [on, setOn] = useState(false);
  change = () => setOn((value) => !value);
  return (
    <HStack id="stack" width={400} className={on ? "on" : "off"}>
      <MemoChild />
    </HStack>
  );
}

function InvalidAfterUpdate({ value }: { value: number }) {
  const [maximum, setMaximum] = useState<number>();
  change = () => setMaximum(value);
  return <HStack id="stack" width={400} maxWidth={maximum} />;
}

function DynamicBounds({
  bound,
  grow
}: {
  bound: "maxWidth" | "maxHeight";
  grow: boolean;
}) {
  const [expanded, setExpanded] = useState(!grow);
  change = () => setExpanded((value) => !value);
  return (
    <HStack
      id="stack"
      width={100}
      height={100}
      {...{ [bound]: expanded ? 80 : 40 }}
      style={{ border: `${grow && expanded ? 30 : 10}px solid` }}
    />
  );
}

function Cases({ name }: { name: string }) {
  switch (name) {
    case "grow-maxWidth":
    case "grow-maxHeight":
    case "shrink-maxWidth":
    case "shrink-maxHeight":
      return (
        <DynamicBounds
          bound={name.split("-")[1] as "maxWidth" | "maxHeight"}
          grow={name.startsWith("grow-")}
        />
      );
    case "invalid-nan":
      return <InvalidAfterUpdate value={NaN} />;
    case "invalid-infinity":
      return <InvalidAfterUpdate value={Infinity} />;
    case "single-between":
    case "single-around":
    case "single-evenly":
      return (
        <HStack
          id="stack"
          width={400}
          justify={name.slice(7) as "between" | "around" | "evenly"}
        >
          <Item id="a" width={100} height={20} />
        </HStack>
      );
    case "bounded-center":
      return (
        <HStack id="stack" width={600} justify="center">
          <Item id="a" width="stretch" maxWidth={100} height={20} />
          <Item id="b" width="stretch" maxWidth={100} height={20} />
        </HStack>
      );
    case "two-gaps":
      return (
        <HStack id="stack" width={600}>
          <Item id="a" width={80} gapAfter="stretch" />
          <Item id="b" width={80} gapAfter={20} />
          <Item id="c" width={80} gapAfter="stretch" />
          <Item id="d" width={80} />
        </HStack>
      );
    case "zero-gap":
      return (
        <HStack id="stack" width={400} gap={12}>
          <Item id="a" width={100} gapAfter={0} />
          <Item id="b" width={100} />
        </HStack>
      );
    case "box-percentage":
      return (
        <Box>
          <Box width="50%" />
        </Box>
      );
    case "cyclic-stretch":
      return (
        <Box>
          <HStack width="stretch">
            <Item width="50%" />
          </HStack>
        </Box>
      );
    case "between":
      return (
        <HStack id="stack" width={400} gap={16} justify="between">
          <Item id="a" width={100} height={20} />
          <Item id="b" width={100} height={20} />
        </HStack>
      );
    case "center":
      return (
        <HStack id="stack" width={400} gap={12} justify="center">
          <Item id="a" width={100} height={20} />
          <Item id="b" width={100} height={20} gapBefore={20} />
        </HStack>
      );
    case "stretch-max":
      return (
        <HStack id="stack" width={600}>
          <Item id="a" width="stretch" maxWidth={100} height={20} />
          <Item id="b" width="stretch" height={20} />
        </HStack>
      );
    case "stretch-min":
      return (
        <HStack id="stack" width={300}>
          <Item id="a" width="stretch" minWidth={250} height={20} />
          <Item id="b" width="stretch" height={20} />
        </HStack>
      );
    case "stretch-both":
      return (
        <HStack id="stack" width={1000}>
          <Item id="a" width="stretch" minWidth={700} height={20} />
          <Item id="b" width="stretch" maxWidth={200} height={20} />
        </HStack>
      );
    case "fractional":
      return (
        <HStack id="stack" width={600}>
          <Item id="a" width={{ mode: "stretch", weight: 0.2 }} height={20} />
          <Item id="b" width={{ mode: "stretch", weight: 0.4 }} height={20} />
        </HStack>
      );
    case "auto-gap":
      return (
        <HStack id="stack" width={220} gap={8}>
          <Item id="a" width={100} height={20} gapAfter="stretch" />
          <Item id="b" width={100} height={20} />
        </HStack>
      );
    case "overflow":
      return (
        <HStack id="stack" width={180} gap={8} justify="center">
          <Item id="a" width={100} height={20} gapAfter="stretch" />
          <Item id="b" width={100} height={20} />
        </HStack>
      );
    case "wrap":
      return (
        <HStack id="stack" width={300} wrap lineGap={12}>
          <Item id="a" width={150} height={20} shrink />
          <button id="b" style={{ width: 150, height: 20 }} />
          <Item id="c" width={150} height={20} />
        </HStack>
      );
    case "percent":
      return (
        <HStack id="stack" width={320} padding={20}>
          <Item id="a" width="50%" height={20} />
        </HStack>
      );
    case "rtl":
      return (
        <HStack id="stack" width={400} direction="rtl" gap={12}>
          <Item id="a" width={100} height={20} gapAfter={20} />
          <Item id="b" width={100} height={20} />
        </HStack>
      );
    case "vertical":
      return (
        <VStack id="stack" width={200} height={400} gap={12}>
          <Item id="a" width={100} height={100} gapAfter={20} />
          <Item id="b" width={100} height={100} />
        </VStack>
      );
    case "dynamic":
      return <Dynamic />;
    case "axis":
      return <Dynamic axis />;
    case "hidden":
      return (
        <HStack id="stack" width={400} gap={12}>
          <button id="a" style={{ width: 100 }}>
            A
          </button>
          <Item id="b" width={100} height={20} gapBefore={20} />
        </HStack>
      );
    case "nested-hug":
      return (
        <HStack id="stack" width={240} gap={12}>
          <VStack id="a" gap={4}>
            <Item width={120} height={20} />
          </VStack>
          <VStack id="b" gap={4}>
            <Item width={120} height={20} />
          </VStack>
        </HStack>
      );
    case "memo":
      return <Decorated />;
    case "css-hidden":
      return (
        <HStack id="stack" width={400} gap={12}>
          <button style={{ display: "none" }}>A</button>
          <Item width={100} height={20} gapBefore={20} />
        </HStack>
      );
    case "duplicate":
      return (
        <HStack id="stack">
          <Item width={100} gapAfter={20} />
          <Item width={100} gapBefore={20} />
        </HStack>
      );
    case "wrong-parent":
      return (
        <HStack>
          <section>
            <Item width={100} />
          </section>
        </HStack>
      );
    case "text":
      return (
        <HStack>
          anonymous
          <Item width={100} gapBefore={20} />
        </HStack>
      );
    case "missing-ref":
      return (
        <HStack>
          <Item as={MissingRef} width={100} />
        </HStack>
      );
    case "imperative-root":
      return (
        <HStack>
          <Item as={ImperativeRoot} width={100} />
        </HStack>
      );
    case "missing-style":
      return (
        <HStack>
          <Item as={MissingStyle} width={100} />
        </HStack>
      );
    case "missing-variables":
      return (
        <HStack>
          <Item as={MissingVariables} width={100} />
        </HStack>
      );
    case "multiple-shrink":
      return (
        <HStack id="stack" width={200}>
          <Item width={200} shrink />
          <Item width={100} shrink />
        </HStack>
      );
    case "padded-stretch":
      return (
        <HStack width={600}>
          <Item width="stretch" padding={10} />
          <Item width="stretch" />
        </HStack>
      );
    case "border-bounds":
      return (
        <HStack>
          <Item width={10} maxWidth={10} style={{ border: "10px solid" }} />
        </HStack>
      );
    case "absolute":
      return (
        <Box id="box" position="relative">
          <Box position="absolute" width={100} height={100} />
        </Box>
      );
    case "custom-as":
      return (
        <HStack id="stack" width={400} gap={8}>
          <Item
            as={Forwarded}
            id="a"
            width={100}
            height={30}
            gapAfter="stretch"
            ref={externalRef}
            padding={{ horizontal: 8 }}
            onClick={() => events.push("item")}
          >
            Cancel
          </Item>
          <button id="b" style={{ width: 100 }}>
            Next
          </button>
        </HStack>
      );
    default:
      throw new Error(name);
  }
}

export function mount(
  name: string,
  strict = false,
  target: Document = document
) {
  dispose?.();
  errors.length = 0;
  events.length = 0;
  target.body.innerHTML = '<main id="root"></main>';
  const root = createRoot(target.getElementById("root")!);
  const tree = (
    <Boundary>
      <Cases name={name} />
    </Boundary>
  );
  flushSync(() => root.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
  dispose = () => flushSync(() => root.unmount());
}

export function hydrate(html: string) {
  dispose?.();
  errors.length = 0;
  document.body.innerHTML = `<main id="root">${html}</main>`;
  const root = hydrateRoot(
    document.getElementById("root")!,
    <HStack id="stack" width={400} gap={12}>
      <Item id="a" width={100} height={20} />
      <Item id="b" width={100} height={20} gapBefore={20} />
    </HStack>,
    { onRecoverableError: (error) => errors.push(String(error)) }
  );
  dispose = () => flushSync(() => root.unmount());
}

export function update() {
  flushSync(() => change?.());
}
export function unmount() {
  dispose?.();
  dispose = undefined;
}
export function inspect() {
  const result = inspectLayout(document.getElementById("stack")!);
  return {
    path: result.path,
    source: result.source,
    computedStyle: result.computedStyle,
    boundaries: result.boundaries
  };
}
