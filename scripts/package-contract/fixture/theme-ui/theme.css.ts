import {
  base,
  system,
  dark,
  baseClass,
  systemClass,
  darkClass
} from "@mincho-js/preset-theme-ui";

// Layout and component choices belong to the application. Each preset exposes
// the native css/rules/cx/preset API bound to its compiled theme variables.
export const panels = {
  base: {
    themeClass: baseClass,
    root: base.css({
      color: "text",
      bg: "background",
      fontFamily: "body",
      lineHeight: "body"
    }),
    heading: base.css({
      color: "text",
      fontFamily: "heading",
      fontWeight: "heading",
      fontSize: 5
    }),
    link: base.css({ color: "primary" })
  },
  system: {
    themeClass: systemClass,
    root: system.css({
      color: "text",
      bg: "background",
      fontFamily: "body",
      lineHeight: "body"
    }),
    heading: system.css({
      fontFamily: "heading",
      fontWeight: "display",
      fontSize: 5,
      _sm: { fontSize: 6 }
    }),
    link: system.css({ color: "primary", _hover: { color: "secondary" } })
  },
  dark: {
    themeClass: darkClass,
    root: dark.css({
      color: "text",
      bg: "background",
      fontFamily: "body",
      lineHeight: "body"
    }),
    heading: dark.css({
      fontFamily: "heading",
      fontWeight: "display",
      fontSize: 5,
      _sm: { fontSize: 6 }
    }),
    link: dark.css({ color: "primary", _hover: { color: "secondary" } })
  }
};

export const spacing = system.css({ p: 2, mx: -1 });
export const heading = system.rules({
  base: { fontFamily: "heading", fontWeight: "heading" },
  variants: {
    size: {
      regular: { fontSize: 4 },
      display: { fontSize: 5, _sm: { fontSize: 6 } }
    }
  }
});
export const nested = system.cx(systemClass, panels.system.root);
