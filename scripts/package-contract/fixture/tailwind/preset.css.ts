import { css, rules, cx, themeClass } from "@mincho-js/preset-tailwind";

export const section = cx(themeClass, css({ container: true, px: 4 }));
export const truncated = css({ truncate: true });
export const screenReaderOnly = css({ srOnly: true });

export const primary = css([
  {
    bg: { base: "blue-500", _hover: "blue-700" },
    text: "white",
    font: "bold",
    py: 2,
    px: 3
  },
  "rounded"
]);

// The consumer chooses variants; the preset does not precompile demo classes.
export const badge = rules({
  base: { px: 2.5, py: 1, rounded: "full", fontSize: "sm" },
  variants: {
    tone: {
      info: { color: "sky-900", bg: "sky-100" },
      success: { color: "emerald-900", bg: "emerald-100" }
    }
  },
  defaultVariants: { tone: "info" }
});
