import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { defineRules, mincho$ } from "@mincho-js/css";
import {
  base,
  system,
  dark,
  baseClass,
  systemClass,
  darkClass,
  systemModeClasses as systemModes
} from "@mincho-js/preset-theme-ui";
import { themeSpec } from "@mincho-js/theme-ui";

import { customThemeClass, customDarkClass, customVars } from "./custom.css.js";

const colorSchemeQuery = "(prefers-color-scheme: dark)";

type ColorMode = "system" | keyof typeof systemModes;

function subscribeColorScheme(onChange: () => void) {
  const query = window.matchMedia(colorSchemeQuery);

  query.addEventListener("change", onChange);

  return () => query.removeEventListener("change", onChange);
}

function prefersDarkMode() {
  return window.matchMedia(colorSchemeQuery).matches;
}

// mincho$ extracts this static block into CSS while the component stays here.
const panels = mincho$(() => ({
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
}));

function PresetPanel({
  name,
  themeClass,
  children
}: {
  name: keyof typeof panels;
  themeClass?: string;
  children?: ReactNode;
}) {
  const preset = panels[name];

  return (
    <section
      id={name}
      className={`${themeClass ?? preset.themeClass} ${preset.root}`}
    >
      <p className="label">{name}</p>
      <h1 className={preset.heading}>Make it yours</h1>
      <h2>A shared vocabulary</h2>
      <p>
        Write typed styles with <code>theme()</code> and{" "}
        <code>defineRules()</code>.
      </p>
      <p>
        <a className={preset.link} href="https://theme-ui.com/theme-spec">
          Explore the theme specification
        </a>
      </p>
      {children}
    </section>
  );
}

const spacing = system.css({ p: 2, mx: -1 });

const { heading, nested } = mincho$(() => ({
  heading: system.rules({
    base: { fontFamily: "heading", fontWeight: "heading" },
    variants: {
      size: {
        regular: { fontSize: 4 },
        display: { fontSize: 5, _sm: { fontSize: 6 } }
      }
    }
  }),
  nested: system.cx(systemClass, panels.system.root)
}));

function SystemExamples() {
  return (
    <>
      <div id="spacing" className={spacing}>
        Indexed spacing, including negative margins
      </div>
      <div id="recipe" className={heading({ size: "display" })}>
        A native rules() recipe
      </div>
      <aside id="nested" className={nested}>
        <p>This nested theme stays in the default mode.</p>
      </aside>
    </>
  );
}

const { customClass, customButton } = mincho$(() => {
  const { css, rules, cx } = defineRules(themeSpec(customVars, { sm: "48em" }));

  return {
    customClass: cx(
      customThemeClass,
      css({ color: "text", bg: "background", fontFamily: "body" })
    ),
    customButton: rules({
      base: { color: "background", bg: "primary", px: 2, py: 2, _sm: { px: 4 } }
    })
  };
});

function CustomPreset() {
  return (
    <section id="custom" className={customClass}>
      <p className="label">Native Mincho styles</p>
      <p>
        Apply preset tokens with theme(), then write responsive styles and
        variants with defineRules().
      </p>
      <button id="custom-button" type="button" className={customButton()}>
        Custom primary
      </button>
      <div id="custom-dark" className={customDarkClass}>
        <button type="button" className={customButton()}>
          Inherited primary in dark mode
        </button>
      </div>
    </section>
  );
}

export function App() {
  const [colorMode, setColorMode] = useState<ColorMode>("system");
  const prefersDark = useSyncExternalStore(
    subscribeColorScheme,
    prefersDarkMode,
    () => false
  );
  const activeMode =
    colorMode === "system" ? (prefersDark ? "dark" : "default") : colorMode;

  return (
    <>
      <header>
        <h1 id="outside">Theme UI presets for Mincho</h1>
        <p>Three starting points, compiled to static CSS.</p>
        <label htmlFor="mode">System preset color mode</label>
        <select
          id="mode"
          value={colorMode}
          onChange={(event) => setColorMode(event.target.value as ColorMode)}
        >
          <option value="system">Follow OS setting</option>
          <option value="default">Default</option>
          <option value="dark">Dark</option>
          <option value="deep">Deep</option>
          <option value="swiss">Swiss</option>
        </select>
      </header>
      <main id="presets">
        <PresetPanel name="base" />
        <PresetPanel name="system" themeClass={systemModes[activeMode]}>
          <SystemExamples />
        </PresetPanel>
        <PresetPanel name="dark" />
        <CustomPreset />
      </main>
    </>
  );
}
