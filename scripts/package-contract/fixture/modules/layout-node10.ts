import { hstack } from "@mincho-js/css/layout";
import { selectors } from "@mincho-js/css/selectors";
import { selectors as rootSelectors } from "@mincho-js/css";
import { normalizeStack } from "@mincho-js/css/layout/core";
import type { ComponentPropsWithRef } from "react";
import { HStack, type BoxProps, type ItemProps } from "@mincho-js/react/layout";
import { squircle } from "@mincho-js/css/squircle";
import { getSquirclePath } from "@mincho-js/css/squircle/core";
import * as squircleReact from "@mincho-js/react/squircle";

const squircleAnchor: squircleReact.SquircleMaskProps<"a"> = {
  as: "a",
  href: "/",
  radius: 16
};
const invalidSquircle: squircleReact.SquircleMaskProps<"button"> = {
  as: "button",
  // @ts-expect-error the selected target determines the allowed attributes
  href: "/"
};
void [
  squircle,
  getSquirclePath,
  squircleReact.SquircleMask,
  squircleAnchor,
  invalidSquircle
];

const anchor: BoxProps<"a"> = { as: "a", href: "/", width: 100 };
void [hstack, normalizeStack, HStack, anchor];

declare const Link: (
  props: ComponentPropsWithRef<"a"> & { to: string }
) => import("react").ReactElement;
const custom: ItemProps<typeof Link> = { as: Link, to: "/", width: 100 };
// @ts-expect-error the chosen target requires to
const missing: ItemProps<typeof Link> = { as: Link };
void [custom, missing];

const condition: selectors.Condition = rootSelectors.first();
const selector: string = selectors.children(".list", ".item", condition);
void selector;
