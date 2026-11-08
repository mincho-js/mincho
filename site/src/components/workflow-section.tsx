import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getI18n } from "../i18n/server";
import type { Locale } from "../i18n/routing";
import { HighlightCode } from "./highlight-code";
import { WorkflowShowcase } from "./workflow-showcase";

export async function WorkflowSection({ locale }: { locale: Locale }) {
  const i18n = getI18n(locale);
  const [theme, button, component] = await Promise.all(
    ["theme.css.ts", "button.css.ts", "Button.tsx"].map((filename) =>
      readFile(join(process.cwd(), "examples/workflow", filename), "utf8")
    )
  );
  const recipeStart = button.indexOf("export const button =");
  if (recipeStart < 0)
    throw new Error("The workflow example must export its button recipe.");
  const snippets = [
    { filename: "theme.css.ts", source: theme },
    { filename: "button.css.ts", source: button.slice(0, recipeStart) },
    { filename: "button.css.ts", source: button.slice(recipeStart) },
    { filename: "Button.tsx", source: component }
  ].map(({ filename, source }) => ({
    filename,
    code: <HighlightCode source={source} />
  }));

  return (
    <section
      id="workflow"
      className="mincho-workflow"
      aria-labelledby="workflow-title"
    >
      <div className="mincho-section-heading">
        <p className="mincho-eyebrow">
          {i18n._({
            id: "workflow.eyebrow",
            message: "FROM A TOKEN TO A COMPONENT"
          })}
        </p>
        <h2 id="workflow-title">
          {i18n._({
            id: "workflow.title",
            message: "One system. Every style connected."
          })}
        </h2>
        <p className="mincho-section-description">
          {i18n._({
            id: "workflow.description",
            message:
              "Start with your theme. Give it a typed vocabulary. Build variants, then bring them into your components."
          })}
        </p>
      </div>
      <WorkflowShowcase snippets={snippets} locale={locale} />
    </section>
  );
}
