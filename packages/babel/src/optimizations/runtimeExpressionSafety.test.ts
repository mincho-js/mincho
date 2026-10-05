import { afterEach, describe, expect, it, vi } from "vitest";
import * as moduleGraph from "../moduleGraph.js";
import { analyzeRuntimeExpressions } from "./runtimeExpressions.js";

const createModuleGraph = moduleGraph.createModuleGraph;
const factory = `
  import { createCompiledRuntimeFn as make } from "@mincho-js/css/rules/createRuntimeFn";
  const r = make({ defaultClassName: "base", variantClassNames: { size: { small: "small", large: "large" } }, defaultVariants: {}, compoundVariants: [] }, { width: "--width" });
`;

afterEach(() => vi.restoreAllMocks());

function analyze(source: string, modules: Record<string, string> = {}) {
  const scans: number[] = [];
  vi.spyOn(moduleGraph, "createModuleGraph").mockImplementation((options) => {
    const graph = createModuleGraph(options);
    const values = graph.modules.values.bind(graph.modules);
    vi.spyOn(graph.modules, "values").mockImplementation(() => {
      scans.push(graph.modules.size);

      return values();
    });

    return graph;
  });
  const flow = analyzeRuntimeExpressions({
    filename: "/app.tsx",
    source,
    runtimeCodegen: true,
    styledComponents: true
  });
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

  return { result: step.value, scans };
}

describe("runtime factory safety analysis", () => {
  it.each(["props", "calls", "styled"])(
    "reuses graph scans for repeated %s uses of one recipe",
    (kind) => {
      const source = (count: number) => {
        const uses = Array.from({ length: count }, (_, index) =>
          kind === "styled"
            ? `const Button${index} = $$styled("div", r);`
            : kind === "props"
              ? `r.props(input);`
              : `r(input);`
        ).join("\n");

        return `${factory}
          import { $$styled } from "@mincho-js/react/runtime";
          ${uses}
          ${kind === "styled" ? `export const App = () => <>${Array.from({ length: count }, (_, index) => `<Button${index} />`).join("")}</>;` : ""}
        `;
      };

      const single = analyze(source(1));
      const repeated = analyze(source(20));
      const outputs = (result: typeof single.result) =>
        kind === "styled" ? result.elements : result.expressions;

      expect(outputs(single.result)).toHaveLength(1);
      expect(outputs(repeated.result)).toHaveLength(20);
      // Each distinct styled factory needs its own proof, but shares the recipe proof.
      expect(repeated.scans).toHaveLength(
        single.scans.length + (kind === "styled" ? 19 : 0)
      );
    }
  );

  it.each([false, true])(
    "keeps props and calls-only proofs separate with calls first: %s",
    (callsFirst) => {
      const props = "r.props(input);";
      const call = "r(input);";
      const { result } = analyze(
        `${factory} const metadata = r.variants; ${callsFirst ? call + props : props + call}`
      );

      expect(result.expressions).toHaveLength(1);
      expect(result.expressions[0]?.expression).toMatchObject({
        type: "CallExpression",
        callee: { name: expect.stringContaining("mapVarProps") }
      });
    }
  );

  it("keeps closed recipe proofs separate from exported styled recipes", () => {
    const { result } = analyze(`${factory}
      import { $$styled } from "@mincho-js/react/runtime";
      export { r };
      r.props(input);
      const Button = $$styled("div", r);
      export const App = () => <Button />;
    `);

    expect(result.expressions).toHaveLength(0);
    expect(result.elements).toHaveLength(1);
  });

  it("rechecks a recipe after loading another module", () => {
    const { result, scans } = analyze(
      `import { r } from "/extracted_rules.css.ts";
       import { other } from "/other.js";
       r.props(input); other(); r.props(input);`,
      {
        "/extracted_rules.css.ts": `${factory} export { r };`,
        "/other.js": `${factory} export { r as other };`
      }
    );

    expect(result.expressions).toHaveLength(2);
    expect(scans).toEqual([2, 3, 3]);
  });
});
