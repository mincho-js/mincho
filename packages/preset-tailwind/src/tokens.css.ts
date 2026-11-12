import { keyframes } from "@mincho-js/css";
import type { TailwindTokens } from "@mincho-js/tailwind";

import { defaultTokens } from "./defaults.js";
import { animationFrames } from "./keyframes.js";

// Evaluated at package build: the published token entry contains only values.
export const tailwindTokens: TailwindTokens = {
  ...defaultTokens,
  animations: Object.fromEntries(
    Object.entries(animationFrames).map(([name, frames]) => [
      name,
      defaultTokens.animations[name as keyof typeof animationFrames].replace(
        name,
        keyframes(frames, name)
      )
    ])
  ) as TailwindTokens["animations"]
};
