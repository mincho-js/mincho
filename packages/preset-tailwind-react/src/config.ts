import { extractCalls as tailwindExtractCalls } from "@mincho-js/preset-tailwind/config";
import { styledCalls } from "@mincho-js/react/config";

export const extractCalls = {
  ...tailwindExtractCalls,
  "@mincho-js/preset-tailwind-react": [
    ...tailwindExtractCalls["@mincho-js/preset-tailwind"],
    ...styledCalls
  ]
} as const;
