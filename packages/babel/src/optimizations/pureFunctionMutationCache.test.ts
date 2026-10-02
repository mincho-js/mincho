import { types as t, type NodePath } from "@babel/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseModuleProgram } from "../moduleGraph.js";
import * as mutation from "../staticCssEval/sameFile/mutation.js";
import { analyzePureFunctions } from "./pureFunctions.js";

afterEach(() => vi.restoreAllMocks());

function analyze(
  source: string,
  modules: Record<string, string> = {},
  program?: NodePath<t.Program>
) {
  const flow = analyzePureFunctions({ filename: "/app.tsx", source, program });
  let step = flow.next();

  while (!step.done) {
    const request = step.value;
    step = flow.next(
      request.kind === "load"
        ? (modules[request.id] ?? null)
        : request.kind === "resolve" && modules[request.source]
          ? request.source
          : null
    );
  }

  return step.value;
}

describe("pure function analysis mutation cache", () => {
  it.each(["data", "helper", "imported helper", "mutated data"])(
    "checks each binding once across repeated %s candidates",
    (kind) => {
      const check = vi.spyOn(mutation, "hasStaticCssEvalBindingMutation");
      const helper =
        "const scale = 4; function pad(n) { return { padding: n * scale }; }";
      const calls = Array(40)
        .fill(kind.includes("helper") ? "css(pad(4));" : "css(tokens);")
        .join("\n");
      const setup =
        kind === "imported helper"
          ? 'import { pad } from "/helper.ts";'
          : kind === "helper"
            ? helper
            : `const tokens = { padding: 4 }; ${kind === "mutated data" ? "tokens.padding = 8;" : ""}`;
      const result = analyze(
        `import { css } from "@mincho-js/css"; ${setup} ${calls}`,
        { "/helper.ts": `${helper} export { pad };` }
      );

      expect(result.replacements).toHaveLength(
        kind.includes("helper") ? 40 : 0
      );
      expect(check).toHaveBeenCalled();
      expect(check).toHaveBeenCalledTimes(
        new Set(check.mock.calls.map(([, binding]) => binding)).size
      );
      if (kind === "mutated data") expect(result.diagnostics).toHaveLength(40);
    }
  );

  it("keeps node and call budgets independent for every candidate", () => {
    const result = analyze(`
      import { css } from "@mincho-js/css";
      const scale = 4;
      function pad(n) { return { padding: [${Array(200).fill("n").join(",")}] }; }
      ${Array(60).fill("css(pad(scale));").join("\n")}
      css({ padding: scale });
    `);

    expect(result.replacements).toHaveLength(60);
    expect(result.diagnostics.every((entry) => entry.result === "folded")).toBe(
      true
    );
  });

  it("rechecks the same binding in a new analysis after an AST edit", () => {
    const source = `
      import { css } from "@mincho-js/css";
      const scale = 4;
      function pad(n) { return { padding: n * scale }; }
      css(pad(4));
    `;
    const program = parseModuleProgram("/app.tsx", source);
    const binding = program.scope.getBinding("scale");
    expect(analyze(source, {}, program).replacements).toHaveLength(1);

    program.pushContainer(
      "body",
      t.expressionStatement(
        t.assignmentExpression("=", t.identifier("scale"), t.numericLiteral(8))
      )
    );

    expect(program.scope.getBinding("scale")).toBe(binding);
    expect(analyze(source, {}, program).replacements).toHaveLength(0);
  });
});
