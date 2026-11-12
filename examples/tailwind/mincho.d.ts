import type { css } from "@mincho-js/preset-tailwind";
import "@mincho-js/react";

declare module "@mincho-js/react" {
  interface CssPropConfig {
    css: typeof css;
  }
}
