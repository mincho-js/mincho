import { describe, expect, it } from "vitest";
import { parseModuleProgram } from "../moduleGraph.js";
import type { ProgramScope } from "../types.js";
import { prepareModuleSourceFixture } from "../testUtils/moduleSourceFixture.js";
import { sourceInvocationResultProof } from "./sourceInvocationResult.js";

function inspect(
  provider: string,
  expression: string,
  setup = "",
  override = ""
) {
  const source = `import {fn} from 'provider'; ${setup} ${override} const result = ${expression};`;
  const prepared = prepareModuleSourceFixture(
    source,
    { provider },
    { provider: ["fn"] }
  );
  const program = parseModuleProgram("/fixture/entry.ts", source);
  (program.scope as ProgramScope).minchoData = {
    imports: new Map(),
    bindings: [],
    nodes: [],
    cssFile: "",
    extractCalls: prepared
  };
  const binding = program.scope.getBinding("result")!;
  if (!binding.path.isVariableDeclarator())
    throw new Error("Expected variable");
  const init = binding.path.get("init");
  if (!init.isCallExpression() && !init.isOptionalCallExpression()) return;
  return sourceInvocationResultProof(init)?.kind;
}

describe("source invocation primitive result receipts", () => {
  it.each([
    "'red'",
    "5 + 2",
    "undefined",
    "{toString(){ throw Error() }}.value"
  ])("uses only proved primitive actuals: %s", (arg) => {
    expect(inspect("export const fn = x => x", `fn(${arg})`)).toBe(
      arg.startsWith("{") ? undefined : "primitive"
    );
  });
  it("follows a constant primitive alias", () => {
    expect(
      inspect("export const fn = x => x", "fn(color)", "const color = 'red';")
    ).toBe("primitive");
  });
  it("supports omitted plain parameters without approving defaults", () => {
    expect(inspect("export const fn = x => x", "fn()")).toBe("primitive");
    expect(inspect("export const fn = (x = {}) => x", "fn()")).toBeUndefined();
  });
  it.each([
    "fn({color:'red'})",
    "fn(globalValue)",
    "fn(...args)",
    "fn?.('red')"
  ])(
    "rejects object, unknown, spread or optional actuals: %s",
    (expression) => {
      expect(inspect("export const fn = x => x", expression)).toBeUndefined();
    }
  );
  it("keeps primitive result separate from invocation effects", () => {
    expect(
      inspect(
        "let n=0; export function fn(value){ value.color='blue'; n++; return 'class' }",
        "fn({color:'red'})"
      )
    ).toBe("primitive");
  });
  it("does not certify a singleton result", () => {
    expect(
      inspect("const shared={}; export const fn = () => shared", "fn()")
    ).toBeUndefined();
  });
  it("does not trust a reassigned imported callable", () => {
    expect(
      inspect("export let fn = x => x", "fn('red')", "", "fn = other;")
    ).toBeUndefined();
  });
  it("rejects an overridden source export", () => {
    expect(
      inspect("export let fn = x => x; fn = external;", "fn('red')")
    ).toBeUndefined();
  });
  it("rejects namespace writes by another consumer", () => {
    expect(
      inspect(
        "export const fn = x => x",
        "fn('red')",
        "import * as ns from 'provider'; ns.fn = other;"
      )
    ).toBeUndefined();
  });
  it("does not interpret construction as normal call results", () => {
    expect(
      inspect("export const fn = x => x", "new fn('red')")
    ).toBeUndefined();
  });
  it("does not confuse a destructured inherited function with its primitive initializer", () => {
    const { constructor } = 1;
    expect(typeof constructor).toBe("function");
    expect(
      inspect(
        "export const fn = x => x",
        "fn(constructor)",
        "const {constructor} = 1;"
      )
    ).toBeUndefined();
  });
  it.each([
    "const {constructor: alias} = 1;",
    "const {...alias} = 1;",
    "const {missing: alias = {color:'red'}} = 1;"
  ])(
    "does not certify destructuring without a selection proof: %s",
    (setup) => {
      expect(
        inspect("export const fn = x => x", "fn(alias)", setup)
      ).toBeUndefined();
    }
  );
});
