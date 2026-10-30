import { hstack } from "@mincho-js/css/layout";
import { normalizeStack } from "@mincho-js/css/layout/core";
import type { ComponentPropsWithRef } from "react";
import { HStack, type BoxProps, type ItemProps } from "@mincho-js/react/layout";

const anchor: BoxProps<"a"> = { as: "a", href: "/", width: 100 };
void [hstack, normalizeStack, HStack, anchor];

declare const Link: (
  props: ComponentPropsWithRef<"a"> & { to: string }
) => import("react").ReactElement;
const custom: ItemProps<typeof Link> = { as: Link, to: "/", width: 100 };
// @ts-expect-error the chosen target requires to
const missing: ItemProps<typeof Link> = { as: Link };
// @ts-expect-error asChild is not part of the Layout API
const removed: ItemProps = { asChild: true };
void [custom, missing, removed];
