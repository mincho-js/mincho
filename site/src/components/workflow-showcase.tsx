"use client";

import { useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useLingui } from "@lingui/react";
import { Button, mintTheme, peachTheme } from "../generated/workflow.mjs";
import { localizedPath, type Locale } from "../i18n/routing";
import { ArrowIcon } from "./botanical-art";
import "../generated/workflow.css";
import "../styles/workflow.css";

export function WorkflowShowcase({
  snippets,
  locale
}: {
  snippets: { filename: string; code: ReactNode }[];
  locale: Locale;
}) {
  const { i18n } = useLingui();
  const [step, setStep] = useState(0);
  const [palette, setPalette] = useState("mint");
  const [tone, setTone] = useState<"accent" | "soft">("accent");
  const [size, setSize] = useState<"small" | "large">("large");
  const [count, setCount] = useState(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const steps = [
    {
      api: "theme()",
      title: i18n._({
        id: "workflow.theme.title",
        message: "Plant your tokens"
      }),
      description: i18n._({
        id: "workflow.theme.body",
        message:
          "Colors, spacing, and radii become typed CSS variables. A second theme reuses the same contract."
      }),
      href: "/docs/theme"
    },
    {
      api: "defineRules()",
      title: i18n._({
        id: "workflow.define.title",
        message: "Define your vocabulary"
      }),
      description: i18n._({
        id: "workflow.define.body",
        message:
          "Connect theme tokens to CSS properties. Add shortcuts like px and py, with autocomplete for every allowed value."
      }),
      href: "/docs/define-rules"
    },
    {
      api: "rules()",
      title: i18n._({
        id: "workflow.rules.title",
        message: "Grow your variants"
      }),
      description: i18n._({
        id: "workflow.rules.body",
        message:
          "Use rules from your definition to build a button with typed tones and sizes. Every variant shares the same tokens."
      }),
      href: "/docs/define-rules#scoped-recipes"
    },
    {
      api: "cx() + React",
      title: i18n._({
        id: "workflow.component.title",
        message: "Make it a component"
      }),
      description: i18n._({
        id: "workflow.component.body",
        message:
          "Select a variant and compose its classes with cx. Wrap the component in a theme, and it is ready to use."
      }),
      href: "/docs/classname"
    }
  ];

  return (
    <div className="mincho-workflow-demo">
      <div
        className="mincho-workflow-tabs"
        role="tablist"
        aria-label={i18n._({
          id: "workflow.steps",
          message: "Design system steps"
        })}
      >
        {steps.map((item, index) => (
          <button
            key={item.api}
            type="button"
            role="tab"
            ref={(node) => {
              tabs.current[index] = node;
            }}
            id={`workflow-tab-${index}`}
            aria-controls={`workflow-panel-${index}`}
            aria-selected={step === index}
            tabIndex={step === index ? 0 : -1}
            onClick={() => setStep(index)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % steps.length
                  : event.key === "ArrowLeft"
                    ? (index + steps.length - 1) % steps.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? steps.length - 1
                        : null;
              if (next === null) return;
              event.preventDefault();
              setStep(next);
              tabs.current[next]?.focus();
            }}
          >
            <span className="mincho-step-number">0{index + 1}</span>
            <span>
              <strong>{item.api}</strong>
              <span className="mincho-step-label">{item.title}</span>
            </span>
            <ArrowIcon />
          </button>
        ))}
      </div>

      <div className="mincho-workflow-grid">
        <div className="mincho-workflow-live">
          <div className="mincho-preview-heading">
            <span className="mincho-live-dot" />
            <h3>
              {i18n._({ id: "workflow.preview", message: "Try the component" })}
            </h3>
          </div>
          <p className="mincho-preview-description">
            {i18n._({
              id: "workflow.previewBody",
              message:
                "The example code powers this button. Change a token set or select a variant."
            })}
          </p>
          <div
            className={`mincho-workflow-stage ${palette === "mint" ? mintTheme : peachTheme}`}
          >
            <Button
              tone={tone}
              size={size}
              onClick={() => setCount((value) => value + 1)}
            >
              {i18n._({ id: "workflow.button", message: "Grow with Mincho" })}
            </Button>
            <p role="status">
              {i18n._({
                id: "workflow.clicks",
                message: "Clicks: {count}",
                values: { count }
              })}
            </p>
          </div>
          <div className="mincho-workflow-controls">
            <fieldset className="mincho-theme-options">
              <legend>
                {i18n._({ id: "workflow.palette", message: "Theme" })}
              </legend>
              <div>
                <button
                  type="button"
                  aria-pressed={palette === "mint"}
                  onClick={() => setPalette("mint")}
                >
                  <span className="mincho-palette-dot mint" />
                  {i18n._({ id: "workflow.mint", message: "Mint" })}
                </button>
                <button
                  type="button"
                  aria-pressed={palette === "peach"}
                  onClick={() => setPalette("peach")}
                >
                  <span className="mincho-palette-dot peach" />
                  {i18n._({ id: "workflow.peach", message: "Peach" })}
                </button>
              </div>
            </fieldset>
            <div className="mincho-variant-options">
              <label>
                {i18n._({ id: "workflow.tone", message: "Tone" })}
                <select
                  value={tone}
                  onChange={(event) =>
                    setTone(event.target.value as typeof tone)
                  }
                >
                  <option value="accent">
                    {i18n._({ id: "workflow.accent", message: "Accent" })}
                  </option>
                  <option value="soft">
                    {i18n._({ id: "workflow.soft", message: "Soft" })}
                  </option>
                </select>
              </label>
              <label>
                {i18n._({ id: "workflow.size", message: "Size" })}
                <select
                  value={size}
                  onChange={(event) =>
                    setSize(event.target.value as typeof size)
                  }
                >
                  <option value="small">
                    {i18n._({ id: "workflow.small", message: "Small" })}
                  </option>
                  <option value="large">
                    {i18n._({ id: "workflow.large", message: "Large" })}
                  </option>
                </select>
              </label>
            </div>
          </div>
          <p className="mincho-workflow-output">
            <code>{`button({ tone: "${tone}", size: "${size}" })`}</code>
          </p>
          <p className="mincho-workflow-note">
            {i18n._({
              id: "workflow.staticNote",
              message:
                "Styles are compiled to static CSS. Interactions select the generated classes."
            })}
          </p>
        </div>

        <div className="mincho-workflow-panels">
          {snippets.map((snippet, index) => (
            <div
              key={steps[index].api}
              role="tabpanel"
              id={`workflow-panel-${index}`}
              aria-labelledby={`workflow-tab-${index}`}
              hidden={step !== index}
            >
              <div className="mincho-step-intro">
                <h3>{steps[index].title}</h3>
                <p>{steps[index].description}</p>
                <Link
                  className="mincho-text-link"
                  href={localizedPath(steps[index].href, locale)}
                >
                  {i18n._({
                    id: "workflow.apiLink",
                    message: "Explore the API"
                  })}
                  <ArrowIcon diagonal />
                </Link>
              </div>
              <div className="mincho-workflow-file">
                <span>{snippet.filename}</span>
                <span>{snippet.filename.endsWith("tsx") ? "TSX" : "TS"}</span>
              </div>
              {snippet.code}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
