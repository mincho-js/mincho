import { useState } from "react";
import { styled, themeClass } from "@mincho-js/preset-tailwind-react";

import {
  button,
  dark as darkTheme,
  effects,
  light as lightTheme,
  vars
} from "./theme.css.js";

const Badge = styled.span({
  base: { px: 2.5, py: 1, rounded: "full", fontSize: "sm" },
  variants: {
    tone: {
      info: { color: "sky-900", bg: "sky-100" },
      success: { color: "emerald-900", bg: "emerald-100" }
    }
  },
  defaultVariants: { tone: "info" }
});

export function App() {
  const [dark, setDark] = useState(false);
  const [tone, setTone] = useState<"solid" | "soft">("solid");
  const [large, setLarge] = useState(false);

  const buttonClass = button({
    tone,
    size: large ? "large" : "regular"
  });

  return (
    <main
      className={themeClass}
      css={{ maxWidth: "1120px", mx: "auto", py: 12, px: 6 }}
    >
      <header css={{ mb: 8 }}>
        <p css={{ color: "stone-600", text: "sm", mb: 3 }}>
          Tailwind styles · Mincho APIs
        </p>
        <h1
          css={{
            text: { base: "3xl", _md: "4xl", _lg: "5xl" },
            font: "bold",
            leading: "tight",
            mb: 4
          }}
        >
          Familiar tokens, native style composition
        </h1>
        <p>Write styles directly in JSX and ship static CSS.</p>
      </header>

      {/* Custom variables use a separate contract; preset utilities inherit themeClass. */}
      <section
        id="custom"
        className={dark ? darkTheme : lightTheme}
        style={{ color: vars.colors.ink, backgroundColor: vars.colors.paper }}
        css={{
          fontFamily: "sans",
          text: "base",
          p: { base: 6, _md: 8 },
          rounded: "2xl",
          shadow: "sm"
        }}
      >
        <h2
          css={{
            text: { base: "3xl", _md: "4xl" },
            font: "bold",
            tracking: "tight"
          }}
        >
          A theme you can change
        </h2>
        <p css={{ mt: 3 }}>
          The preset palette grows with a custom brand color. Both modes share
          one contract.
        </p>
        <div css={{ display: "flex", flexWrap: "wrap", gap: 3, mt: 6 }}>
          <button
            type="button"
            id="mode"
            aria-pressed={dark}
            onClick={() => setDark(!dark)}
            css={{
              border: "1px solid currentColor",
              rounded: "lg",
              py: 2,
              px: 3,
              cursor: "pointer",
              textDecoration: { '&[aria-pressed="true"]': "underline" },
              textUnderlineOffset: { '&[aria-pressed="true"]': "4px" }
            }}
          >
            Dark theme
          </button>
          <button
            type="button"
            id="tone"
            aria-pressed={tone === "soft"}
            onClick={() => setTone(tone === "solid" ? "soft" : "solid")}
            css={{
              border: "1px solid currentColor",
              rounded: "lg",
              py: 2,
              px: 3,
              cursor: "pointer",
              textDecoration: { '&[aria-pressed="true"]': "underline" },
              textUnderlineOffset: { '&[aria-pressed="true"]': "4px" }
            }}
          >
            Soft tone
          </button>
          <button
            type="button"
            id="size"
            aria-pressed={large}
            onClick={() => setLarge(!large)}
            css={{
              border: "1px solid currentColor",
              rounded: "lg",
              py: 2,
              px: 3,
              cursor: "pointer",
              textDecoration: { '&[aria-pressed="true"]': "underline" },
              textUnderlineOffset: { '&[aria-pressed="true"]': "4px" }
            }}
          >
            Large size
          </button>
        </div>
        <div
          id="demonstrations"
          css={{
            display: "grid",
            gridTemplateColumns: {
              base: "1fr",
              _md: "repeat(2, minmax(0, 1fr))"
            },
            gap: 6,
            mt: 8
          }}
        >
          <article css={{ minWidth: 0 }}>
            <h3 css={{ font: "semibold", mb: 4 }}>Typed variants</h3>
            <button id="recipe" type="button" className={buttonClass}>
              Build with Mincho
            </button>
            <p css={{ mt: 4, text: "sm" }}>
              rules() selects the generated classes.
            </p>
          </article>
          <article css={{ minWidth: 0 }}>
            <h3 css={{ font: "semibold", mb: 4 }}>Quarter-step spacing</h3>
            <div
              id="spacing"
              css={{
                p: 1.25,
                mx: -2,
                text: "lg",
                w: "1/2",
                bg: "olive-100",
                color: "slate-900"
              }}
            >
              Spacing × 1.25
            </div>
            <p css={{ mt: 4, text: "sm" }}>
              A numeric scale, paired typography, and fractional width.
            </p>
          </article>
          <article css={{ minWidth: 0 }}>
            <h3 css={{ font: "semibold", mb: 4 }}>Compound styles</h3>
            <p
              id="clamped"
              css={{ lineClamp: 2, maxWidth: "prose", text: "base" }}
            >
              The same default colors, spacing, typography and compound styles
              can be used together in your own components. This paragraph uses a
              two-line clamp and keeps the full text available in the document.
            </p>
          </article>
          <article css={{ minWidth: 0 }}>
            <h3 css={{ font: "semibold", mb: 4 }}>Composed effects</h3>
            <div
              id="effects"
              className={effects}
              style={{
                backgroundColor: vars.colors.paper,
                color: vars.colors.ink
              }}
              css={{
                p: 4,
                rounded: "lg",
                display: "flex",
                alignItems: "center",
                gap: 3
              }}
            >
              <span
                id="animation"
                aria-hidden="true"
                style={{ backgroundColor: vars.colors.brand }}
                css={{
                  size: 3,
                  rounded: "full",
                  animate: {
                    base: "pulse",
                    "@media": {
                      "(prefers-reduced-motion: reduce)": "none"
                    }
                  },
                  flex: "none"
                }}
              />
              Scoped keyframes and multiple shadows
            </div>
          </article>
        </div>
      </section>

      <section id="preset" css={{ container: true, px: 4, mt: 8, mx: "auto" }}>
        <h2 css={{ text: "xl", font: "semibold" }}>
          Styles from the shared preset
        </h2>
        <button
          id="preset-primary"
          type="button"
          css={[
            {
              bg: { base: "blue-500", _hover: "blue-700" },
              text: "white",
              font: "bold",
              py: 2,
              px: 3
            },
            "rounded"
          ]}
        >
          Primary action
        </button>
        <p id="truncated" css={{ truncate: true }}>
          The css prop uses the preset's tokens and compiles only the styles
          this component needs.
        </p>
        <p id="inline-spacing" css={[{ p: 4 }, { px: 3, py: 2 }, { pl: 1 }]}>
          Padding shortcuts compose one side at a time.
        </p>
        <span id="sr-only" css={{ srOnly: true }}>
          This explanation is available to screen readers.
        </span>
        <Badge id="preset-badge" tone={tone === "solid" ? "success" : "info"}>
          Styled recipe
        </Badge>
      </section>
    </main>
  );
}
