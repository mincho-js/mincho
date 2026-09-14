import type { PluginObj } from "@babel/core";
import { transformSync } from "@babel/core";
import { describe, expect, it } from "vitest";
import { typescriptPresetPath } from "../testUtils/babel.js";
import {
  collectJsxCssPropStaticCssEvalCandidates,
  type StaticCssEvalCandidate
} from "./candidates.js";

const importerId = "/project/src/App.tsx";

function collectCandidateFixture(source: string): StaticCssEvalCandidate[] {
  const candidates: StaticCssEvalCandidate[] = [];
  const result = transformSync(source, {
    filename: importerId,
    plugins: [
      function collectCandidatesPlugin(): PluginObj {
        return {
          visitor: {
            Program(path) {
              candidates.push(
                ...collectJsxCssPropStaticCssEvalCandidates(path, {
                  importerId
                })
              );
            }
          }
        };
      }
    ],
    presets: [typescriptPresetPath]
  });

  if (result === null) {
    throw new Error("Failed to parse candidate fixture");
  }

  return candidates;
}

function formatCandidate(
  source: string,
  candidate: StaticCssEvalCandidate
): StaticCssEvalCandidate & { expression: string } {
  return {
    ...candidate,
    expression: source.slice(candidate.expressionStart, candidate.expressionEnd)
  };
}

describe("static css eval candidate collector", () => {
  it("collects identifier and member JSX css prop candidates", () => {
    const source = `
        const style = { color: "red" };
        const buttonKey = "button";
        const styles = {
          button: { color: "blue" },
          1: { color: "green" }
        };

        function App() {
          return <>
            <div css={style} />
            <Component css={styles.button} />
            <Component css={styles["button"]} />
            <Component css={styles[buttonKey]} />
            <Component css={styles[1]} />
          </>;
        }
      `;

    expect(
      collectCandidateFixture(source).map((candidate) =>
        formatCandidate(source, candidate)
      )
    ).toEqual([
      {
        importerId,
        expressionStart: source.indexOf("style} />"),
        expressionEnd: source.indexOf("style} />") + "style".length,
        bindingName: "style",
        expression: "style"
      },
      {
        importerId,
        expressionStart: source.indexOf("styles.button"),
        expressionEnd: source.indexOf("styles.button") + "styles.button".length,
        bindingName: "styles",
        memberPath: ["button"],
        expression: "styles.button"
      },
      {
        importerId,
        expressionStart: source.indexOf('styles["button"]'),
        expressionEnd:
          source.indexOf('styles["button"]') + 'styles["button"]'.length,
        bindingName: "styles",
        memberPath: ["button"],
        expression: 'styles["button"]'
      },
      {
        importerId,
        expressionStart: source.indexOf("styles[1]"),
        expressionEnd: source.indexOf("styles[1]") + "styles[1]".length,
        bindingName: "styles",
        memberPath: ["1"],
        expression: "styles[1]"
      }
    ]);
  });

  it("collects candidates through transparent TypeScript css prop wrappers", () => {
    const source = `
        type ComplexCSSRule = unknown;
        const style = { color: "red" };
        const styles = {
          button: { color: "blue" }
        };

        function App() {
          return <>
            <div css={style as const} />
            <Component css={styles.button satisfies ComplexCSSRule} />
          </>;
        }
      `;

    expect(
      collectCandidateFixture(source).map((candidate) =>
        formatCandidate(source, candidate)
      )
    ).toEqual([
      {
        importerId,
        expressionStart: source.indexOf("style as const"),
        expressionEnd: source.indexOf("style as const") + "style".length,
        bindingName: "style",
        expression: "style"
      },
      {
        importerId,
        expressionStart: source.indexOf("styles.button satisfies"),
        expressionEnd:
          source.indexOf("styles.button satisfies") + "styles.button".length,
        bindingName: "styles",
        memberPath: ["button"],
        expression: "styles.button"
      }
    ]);
  });

  it("ignores non-css JSX expressions and unrelated imports", () => {
    const source = `
        import { style as cssStyle } from "@mincho-js/css";

        const style = { color: "red" };
        const styles = {
          button: { color: "blue" }
        };
        const unused = cssStyle;

        function App() {
          return <div style={style} data-css={styles.button}>{style}</div>;
        }
      `;

    expect(collectCandidateFixture(source)).toEqual([]);
  });
});
