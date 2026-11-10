import {
  base,
  system,
  dark,
  baseClass,
  systemClass,
  darkClass
} from "@mincho-js/preset-theme-ui";

const baseButton = base.rules({
  base: { p: 2 },
  variants: { size: { large: { p: 3 } } }
});
const systemButton = system.rules({
  base: { p: 2 },
  variants: { size: { large: { p: 3 } } }
});
const darkButton = dark.rules({
  base: { p: 2 },
  variants: { size: { large: { p: 3 } } }
});

export const coLocated = {
  base: {
    root: base.cx(baseClass, base.css({ color: "primary", outlineOffset: 7 })),
    button: base.rules.extends(baseButton, {
      base: { outlineOffset: 9 },
      variants: { muted: { true: { opacity: 0.5 } } }
    }),
    multiple: base.rules.multiple({
      label: { base: { outlineOffset: 11 } },
      badge: { variants: { active: { true: { opacity: 0.6 } } } }
    })
  },
  system: {
    root: system.cx(
      systemClass,
      system.css({ color: "primary", outlineOffset: 7 })
    ),
    button: system.rules.extends(systemButton, {
      base: { outlineOffset: 9 },
      variants: { muted: { true: { opacity: 0.5 } } }
    }),
    multiple: system.rules.multiple({
      label: { base: { outlineOffset: 11 } },
      badge: { variants: { active: { true: { opacity: 0.6 } } } }
    })
  },
  dark: {
    root: dark.cx(darkClass, dark.css({ color: "primary", outlineOffset: 7 })),
    button: dark.rules.extends(darkButton, {
      base: { outlineOffset: 9 },
      variants: { muted: { true: { opacity: 0.5 } } }
    }),
    multiple: dark.rules.multiple({
      label: { base: { outlineOffset: 11 } },
      badge: { variants: { active: { true: { opacity: 0.6 } } } }
    })
  }
};
