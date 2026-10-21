import { describe, expect, it, vi } from "vitest";

vi.mock("./compilerResources.js", () => ({
  createVar: () => "var(--factored-gate)"
}));

import { factorCssBooleanGates } from "./cssBooleanGates.js";

describe("CSS gate expression factoring", () => {
  it("factors repeated expressions across nested rules and keeps gate resets local", () => {
    const expression =
      "var(--gate-on-for-this-element, var(--another-gate, 100px)) var(--gate-off-for-this-element, 200px)";

    const before = {
      vars: {
        "--gate-on-for-this-element": "initial",
        "--gate-off-for-this-element": " "
      },
      width: expression,
      height: expression,
      selectors: { "&:focus": { width: expression } }
    };

    const source = JSON.stringify(before);
    const after = factorCssBooleanGates(before);

    expect(after.width).toBe("var(--factored-gate)");
    expect(after.height).toBe(after.width);
    expect(after.selectors["&:focus"].width).toBe(after.width);
    expect(after.vars).toEqual({
      "--gate-on-for-this-element": "initial",
      "--gate-off-for-this-element": " ",
      "var(--factored-gate)": expression
    });
    expect(JSON.stringify(after).length).toBeLessThan(source.length);
  });

  it("keeps single uses and repetitions that would increase CSS size", () => {
    const input = {
      width: "var(--a)",
      height: "var(--a)",
      color: "var(--another-gate, red)"
    };

    expect(factorCssBooleanGates(input)).toEqual(input);
    expect(input).not.toHaveProperty("vars");
  });
});
