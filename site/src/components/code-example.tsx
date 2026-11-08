"use client";

import { useState } from "react";
import { useLingui } from "@lingui/react";
import { ArrowIcon } from "./botanical-art";

const accents = ["#e4e84e", "#9fd4a3", "#e9a17f"] as const;

export function CodeExample() {
  const { i18n } = useLingui();
  const [accent, setAccent] = useState<(typeof accents)[number]>(accents[0]);
  const labels = [
    i18n._({ id: "demo.citron", message: "Citron" }),
    i18n._({ id: "demo.sage", message: "Sage" }),
    i18n._({ id: "demo.clay", message: "Clay" })
  ];

  return (
    <div className="mincho-code-example">
      <div className="mincho-code-title">
        <span>
          <span className="mincho-file-dot" /> button.css.ts
        </span>
        <span>TS</span>
      </div>
      <pre
        className="mincho-example-source"
        aria-label={i18n._({
          id: "demo.code",
          message: "TypeScript styling example"
        })}
      >
        <code>
          <span className="token-keyword">import</span>
          {" { css } "}
          <span className="token-keyword">from</span>{" "}
          <span className="token-string">{'"@mincho-js/css"'}</span>
          {";\n\n"}
          <span className="token-keyword">export const</span>
          {" button = "}
          <span className="token-function">css</span>
          {"({\n  padding: "}
          <span className="token-number">16</span>
          {",\n  backgroundColor: "}
          <span className="token-string">{`"${accent}"`}</span>
          {",\n  color: "}
          <span className="token-string">{'"#17231a"'}</span>
          {",\n  borderRadius: "}
          <span className="token-number">4</span>
          {"\n});"}
        </code>
      </pre>
      <div className="mincho-example-controls">
        <fieldset className="mincho-swatches">
          <legend>
            {i18n._({ id: "demo.accent", message: "Pick a color" })}
          </legend>
          {accents.map((color, index) => (
            <button
              key={color}
              type="button"
              aria-label={labels[index]}
              aria-pressed={accent === color}
              onClick={() => setAccent(color)}
              style={{ backgroundColor: color }}
            >
              {accent === color && <span aria-hidden="true">✓</span>}
            </button>
          ))}
        </fieldset>
        <span
          className="mincho-preview-button"
          style={{ backgroundColor: accent }}
        >
          {i18n._({ id: "demo.preview", message: "Made with Mincho" })}
          <ArrowIcon />
        </span>
      </div>
    </div>
  );
}
