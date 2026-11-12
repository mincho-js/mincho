import { useState } from "react";
import { mincho$ } from "@mincho-js/css";
import { defineRules as defineReactRules } from "@mincho-js/react";
import { css, cx, themeClass } from "@mincho-js/preset-tailwind";
import * as tailwindDefinition from "@mincho-js/preset-tailwind";

import * as styles from "./theme.css.js";

const section = cx(themeClass, css({ container: true, px: 4 }));

const Badge = mincho$(() =>
  defineReactRules(tailwindDefinition).styled.span({
    base: { px: 2.5, py: 1, rounded: "full", fontSize: "sm" },
    variants: {
      tone: {
        info: { color: "sky-900", bg: "sky-100" },
        success: { color: "emerald-900", bg: "emerald-100" }
      }
    },
    defaultVariants: { tone: "info" }
  })
);

export function App() {
  const [dark, setDark] = useState(false);
  const [tone, setTone] = useState<"solid" | "soft">("solid");
  const [large, setLarge] = useState(false);

  const buttonClass = styles.button({
    tone,
    size: large ? "large" : "regular"
  });

  return (
    <main className="page">
      <header>
        <p className="eyebrow">Tailwind styles · Mincho APIs</p>
        <h1>Familiar tokens, native style composition</h1>
        <p>Write styles directly in JSX and ship static CSS.</p>
      </header>

      <section
        id="custom"
        className={`${dark ? styles.dark : styles.light} ${styles.surface}`}
      >
        <h2 className={styles.heading}>A theme you can change</h2>
        <p>
          The preset palette grows with a custom brand color. Both modes share
          one contract.
        </p>
        <div className={styles.actions}>
          <button
            type="button"
            id="mode"
            aria-pressed={dark}
            onClick={() => setDark(!dark)}
          >
            Dark theme
          </button>
          <button
            type="button"
            id="tone"
            aria-pressed={tone === "soft"}
            onClick={() => setTone(tone === "solid" ? "soft" : "solid")}
          >
            Soft tone
          </button>
          <button
            type="button"
            id="size"
            aria-pressed={large}
            onClick={() => setLarge(!large)}
          >
            Large size
          </button>
        </div>
        <div className={`${styles.grid} demonstrations`}>
          <article>
            <h3>Typed variants</h3>
            <button id="recipe" type="button" css={buttonClass}>
              Build with Mincho
            </button>
            <p className="caption">rules() selects the generated classes.</p>
          </article>
          <article>
            <h3>Quarter-step spacing</h3>
            <div id="spacing" className={styles.spacing}>
              Spacing × 1.25
            </div>
            <p className="caption">
              A numeric scale, paired typography, and fractional width.
            </p>
          </article>
          <article>
            <h3>Compound styles</h3>
            <p id="clamped" className={styles.clamped}>
              The same default colors, spacing, typography and compound styles
              can be used together in your own components. This paragraph uses a
              two-line clamp and keeps the full text available in the document.
            </p>
          </article>
          <article>
            <h3>Composed effects</h3>
            <div id="effects" className={styles.effectCard}>
              <span
                id="animation"
                className={styles.status}
                aria-hidden="true"
              />
              Scoped keyframes and multiple shadows
            </div>
          </article>
        </div>
      </section>

      <section id="preset" className={section}>
        <h2>Styles from the shared preset</h2>
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
