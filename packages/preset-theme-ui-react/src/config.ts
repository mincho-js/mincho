import { extractCalls as nativeCalls } from "@mincho-js/preset-theme-ui/config";
import { styledCalls } from "@mincho-js/react/config";

const names = ["base", "system", "dark"] as const;
const definitionCalls = [
  "css",
  "rules",
  "rules.extends",
  "rules.multiple",
  "cx"
] as const;

export const extractCalls = {
  ...nativeCalls,
  "@mincho-js/preset-theme-ui-react": [
    ...definitionCalls,
    ...styledCalls,
    "components",
    "createComponents",
    ...names.flatMap((name) => [
      ...definitionCalls.map((call) => `${name}.${call}` as const),
      ...styledCalls.map((call) => `${name}.${call}` as const),
      `${name}.components` as const
    ])
  ]
} as const;
