import { useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import { defineRules } from "@mincho-js/css";
import {
  base,
  system,
  dark,
  createComponents,
  baseClass,
  systemClass,
  darkClass,
  systemModeClasses as systemModes
} from "@mincho-js/preset-theme-ui-react";
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

const panelGroups = {
  layout: {
    panel: {
      color: "text",
      bg: "background",
      fontFamily: "body",
      lineHeight: "body"
    }
  }
} as const;

const panels = {
  base: base.components(panelGroups),
  system: system.components({
    ...panelGroups,
    buttons: {
      primary: {
        color: "background",
        bg: "primary",
        fontFamily: "body",
        fontWeight: "heading"
      },
      secondary: { variant: "buttons.primary", bg: "secondary" }
    }
  }),
  dark: dark.components(panelGroups)
};

const themeClasses = { base: baseClass, system: systemClass, dark: darkClass };

function PresetPanel({
  name,
  themeClass,
  children
}: {
  name: keyof typeof panels;
  themeClass?: string;
  children?: ReactNode;
}) {
  const { Box, Heading, Link } = panels[name];

  return (
    <Box
      as="section"
      id={name}
      className={themeClass ?? themeClasses[name]}
      variant="layout.panel"
    >
      <p>
        <small>{name}</small>
      </p>
      <Heading as="h1" variant="styles.h1">
        Make it yours
      </Heading>
      <Heading variant="styles.h2">A shared vocabulary</Heading>
      <p>
        Keep semantic tokens in the theme and choose component variants in JSX.
      </p>
      <p>
        <Link href="https://theme-ui.com/theme-spec">
          Explore the theme specification
        </Link>
      </p>
      {children}
    </Box>
  );
}

function SystemExamples() {
  const { Box, Heading, Button } = panels.system;
  const [variant, setVariant] = useState<"primary" | "secondary">("primary");

  return (
    <>
      <Box id="spacing" css={{ p: 2, mx: -1 }}>
        Indexed spacing, including negative margins
      </Box>
      <Heading as="div" id="recipe" variant="display">
        A reusable display variant
      </Heading>
      <Button
        id="variant-button"
        type="button"
        variant={variant}
        onClick={() =>
          setVariant(variant === "primary" ? "secondary" : "primary")
        }
      >
        Switch from {variant}
      </Button>
      <Box css={{ mt: 3 }}>
        <Button
          id="inline-button"
          type="button"
          css={{
            px: { base: 4, _sm: 5 },
            bg: { base: "secondary", _hover: "accent" }
          }}
        >
          Local styles
        </Button>
      </Box>
      <Box
        as="aside"
        id="nested"
        className={systemClass}
        variant="layout.panel"
      >
        <p>This nested theme stays in the default mode.</p>
      </Box>
    </>
  );
}

const { Box: CustomBox, Button: CustomButton } = createComponents(
  defineRules(themeSpec(customVars, { sm: "48em" })),
  {
    ...panelGroups,
    buttons: {
      primary: {
        px: { base: 2, _sm: 4 },
        py: 2,
        color: "background",
        bg: "primary"
      },
      secondary: { variant: "buttons.primary", bg: "secondary" }
    }
  }
);

function CustomPreset() {
  return (
    <CustomBox
      as="section"
      id="custom"
      className={customThemeClass}
      variant="layout.panel"
    >
      <p>
        <small>A custom theme</small>
      </p>
      <p>
        Change the primary token once. The same button variant uses it in both
        color modes.
      </p>
      <CustomButton id="custom-button" type="button" variant="primary">
        Custom primary
      </CustomButton>
      <CustomBox
        id="custom-dark"
        className={customDarkClass}
        variant="layout.panel"
      >
        <CustomButton type="button" variant="primary">
          Inherited primary in dark mode
        </CustomButton>
      </CustomBox>
    </CustomBox>
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
