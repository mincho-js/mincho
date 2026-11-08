import { getI18n } from "../i18n/server";
import type { Locale } from "../i18n/routing";
import { HighlightCode } from "./highlight-code";

// Both snippets produce equivalent CSS through Vanilla Extract.
// Mincho normalizes its nested selectors before Vanilla Extract compiles them.
const vanillaExtract = `import { style } from "@vanilla-extract/css";

export const navLink = style({
  paddingBlock: 8,
  paddingInline: 12,
  color: "#5f685d",
  ":hover": { color: "#17231a" },
  "::after": { content: '"→"' },
  selectors: {
    '&[aria-current="page"]': { color: "#079b59" },
    '&[aria-current="page"]:hover': {
      textDecoration: "underline"
    }
  }
});`;

const mincho = `import { css } from "@mincho-js/css";

export const navLink = css({
  padding: { Block: 8, Inline: 12 },
  color: "#5f685d",
  _hover: { color: "#17231a" },
  __after: { content: '"→"' },
  '[aria-current="page"]': {
    color: "#079b59",
    _hover: { textDecoration: "underline" }
  }
});`;

export function CompareSection({ locale }: { locale: Locale }) {
  const i18n = getI18n(locale);
  const panels = [
    { label: "Vanilla Extract", source: vanillaExtract },
    { label: "Mincho", source: mincho }
  ];

  return (
    <section className="mincho-compare" aria-labelledby="compare-title">
      <div className="mincho-section-heading">
        <p className="mincho-eyebrow">
          {i18n._({
            id: "compare.eyebrow",
            message: "Compared with Vanilla Extract"
          })}
        </p>
        <h2 id="compare-title">
          {i18n._({
            id: "compare.title",
            message: "Keep each state next to the selector it changes"
          })}
        </h2>
        <p className="mincho-section-description">
          {i18n._({
            id: "compare.description",
            message:
              "Mincho compiles to Vanilla Extract, so both files produce the same style. In Mincho, a hover inside a selector stays nested instead of repeating the selector."
          })}
        </p>
      </div>
      <div className="mincho-compare-grid">
        {panels.map((panel) => (
          <figure key={panel.label}>
            <figcaption className="mincho-workflow-file">
              <span>{panel.label}</span>
              <span>nav-link.css.ts</span>
            </figcaption>
            <HighlightCode source={panel.source} />
          </figure>
        ))}
      </div>
    </section>
  );
}
