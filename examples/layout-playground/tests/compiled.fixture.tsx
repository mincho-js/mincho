/**
 * Built twice by the browser test, with and without the compiler's layout JSX
 * lowering, to compare compiled and runtime geometry. Static layout values let
 * the compiler lower elements; `Mixed` keeps a runtime Item on purpose.
 */
import { forwardRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ComponentPropsWithoutRef } from "react";
import type { Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { Box, HStack, Item, Stack, VStack } from "@mincho-js/react/layout";
import { hstack, item } from "@mincho-js/css/layout";

const Button = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button">
>((props, ref) => <button {...props} ref={ref} />);

function Mixed({ width }: { width: number }) {
  return (
    <HStack id="mixed" width={400} gap={12}>
      <Item id="mixed-a" width={width} height={20} />
      <Item id="mixed-b" width={100} height={20} gapBefore={30} />
    </HStack>
  );
}

function MixedStretch({ gap }: { gap: number }) {
  return (
    <HStack id="mixed-stretch" width={400} gap={gap}>
      <Item id="mixed-stretch-a" width="stretch" height={20} gapAfter={gap} />
      <Item id="mixed-stretch-b" width="stretch" height={20} />
    </HStack>
  );
}

function StaticStretch() {
  return <Item id="component-stretch-b" width="stretch" height={20} />;
}

function ComponentStretch({ gap }: { gap: number }) {
  return (
    <HStack id="component-stretch" width={400} gap={gap}>
      <Item id="component-stretch-a" width="stretch" height={20} />
      <StaticStretch />
    </HStack>
  );
}

function StaticBoundary({ wide }: { wide: boolean }) {
  return wide ? (
    <Item id="component-boundary-b" width={100} height={20} gapBefore={40} />
  ) : (
    <Item id="component-boundary-b" width={100} height={20} gapBefore={20} />
  );
}

let toggleBoundary: (() => void) | undefined;
function ComponentBoundary() {
  const [wide, setWide] = useState(true);
  toggleBoundary = () => setWide((value) => !value);
  return (
    <HStack id="component-boundary" width={400} gap={12}>
      <Item id="component-boundary-a" width={100} height={20} />
      <StaticBoundary wide={wide} />
    </HStack>
  );
}

function ParentBoundaries({ width }: { width: number }) {
  return (
    <HStack id="parent-boundaries" width={400} gap={width / 9}>
      <Box id="parent-box" width={120}>
        <VStack id="box-child" width={width}>
          <Item width={32} height={20} />
        </VStack>
      </Box>
      <Item id="parent-item" width={120}>
        <VStack id="item-child" width={width}>
          <Item width={32} height={20} />
        </VStack>
      </Item>
    </HStack>
  );
}

let toggle: (() => void) | undefined;
function Conditional() {
  const [shown, setShown] = useState(true);
  toggle = () => setShown((value) => !value);
  return (
    <HStack id="conditional" width={400} gap={12}>
      {shown && <button style={{ width: 100 }}>A</button>}
      <Item id="conditional-b" width={100} height={20} gapBefore={20} />
    </HStack>
  );
}

function Cases() {
  return (
    <div id="root" style={{ width: 800 }}>
      <div id="patterns" className={hstack({ width: 600 })}>
        <div
          id="patterns-a"
          className={item(
            { width: { mode: "stretch", weight: 0.2 }, height: 20 },
            { axis: "horizontal", width: 600 }
          )}
        />
        <div
          id="patterns-b"
          className={item(
            { width: { mode: "stretch", weight: 0.4 }, height: 20 },
            { axis: "horizontal", width: 600 }
          )}
        />
      </div>
      <HStack id="repeated" width={400} gap={8}>
        <Item id="repeated-a" width={80} height={20} />
        <Item id="repeated-b" height={20} width={80} />
        <Item id="repeated-c" width={80} height={20} padding={0} />
        <Item id="repeated-d" width={80} height={20} />
      </HStack>
      <HStack id="edge-before" width={400} gap={8}>
        <Item id="edge-before-a" width={80} height={20} gapBefore="stretch" />
        <Item width={80} height={20} />
      </HStack>
      <HStack id="edge-after" width={400} gap={8} justify="end">
        <Item id="edge-after-a" width={80} height={20} />
        <Item width={80} height={20} gapAfter="stretch" />
      </HStack>
      <HStack id="edge-rtl" width={400} gap={8} direction="rtl">
        <Item id="edge-rtl-a" width={80} height={20} gapBefore="stretch" />
        <Item width={80} height={20} />
      </HStack>
      <VStack id="edge-vertical" height={400} gap={8}>
        <Item id="edge-vertical-a" height={80} width={20} gapBefore="stretch" />
        <Item height={80} width={20} />
      </VStack>
      <HStack id="toolbar" width={600} gap={8} padding={16} align="center">
        <Item id="toolbar-a" width={40} height={40} />
        <Item id="toolbar-b" width={80} height={24} gapBefore="stretch" />
        <Item id="toolbar-c" width={80} height={24} gapBefore={20} />
      </HStack>
      <VStack id="card" width={300} gap={12} padding={20}>
        <Box id="card-art" width="stretch" height={72} />
        <HStack id="card-actions" width="stretch" gap={8} justify="end">
          <Item id="card-a" width={60} height={24} />
          <Item id="card-b" width={60} height={24} />
        </HStack>
      </VStack>
      <HStack id="weights" width={600} gap={0}>
        <Item
          id="weights-a"
          width={{ mode: "stretch", weight: 0.2 }}
          height={10}
        />
        <Item
          id="weights-b"
          width={{ mode: "stretch", weight: 0.4 }}
          height={10}
        />
      </HStack>
      <HStack id="bounded" width={600} justify="center">
        <Item id="bounded-a" width="stretch" maxWidth={100} height={10} />
        <Item id="bounded-b" width="stretch" maxWidth={100} height={10} />
      </HStack>
      <HStack id="rtl" width={400} gap={12} direction="rtl">
        <Item id="rtl-a" width={100} height={10} />
        <Item id="rtl-b" width={100} height={10} gapBefore={20} />
      </HStack>
      <Stack id="vertical" axis="vertical" width={200} height={300} gap={12}>
        <Item id="vertical-a" width="stretch" height={30} />
        <Item id="vertical-b" width={100} height="stretch" gapAfter={20} />
        <Item id="vertical-c" width={100} height={30} alignSelf="end" />
      </Stack>
      <HStack id="wrap" width={250} wrap gap={8} lineGap={12}>
        <Item id="wrap-a" width={100} height={20} />
        <Item id="wrap-b" width={100} height={20} />
        <Item id="wrap-c" width={100} height={20} />
      </HStack>
      <HStack id="shrink" width={200} gap={8} overflow="clip">
        <Item id="shrink-a" width={80} height={20} />
        <Item id="shrink-b" width={200} minWidth={40} height={20} shrink />
      </HStack>
      <Box id="overlay" width={200} height={100} position="relative">
        <Box
          id="overlay-a"
          position="absolute"
          top={10}
          left={20}
          width={50}
          height={20}
        />
      </Box>
      <HStack id="as-targets" width={400} gap={8}>
        <Item as="button" id="as-native" type="button" width={100} height={30}>
          Native
        </Item>
        <Item
          as={Button}
          id="as-custom"
          type="button"
          width={100}
          height={30}
          gapBefore="stretch"
        >
          Custom
        </Item>
      </HStack>
      <Mixed width={140} />
      <MixedStretch gap={20} />
      <ComponentStretch gap={20} />
      <ComponentBoundary />
      <ParentBoundaries width={72} />
      <Conditional />
    </div>
  );
}

let root: Root | undefined;
export function mount() {
  root?.unmount();
  document.body.innerHTML = '<main id="app"></main>';
  root = createRoot(document.getElementById("app")!);
  flushSync(() => root!.render(<Cases />));
}
export function update() {
  flushSync(() => {
    toggle?.();
    toggleBoundary?.();
  });
}
