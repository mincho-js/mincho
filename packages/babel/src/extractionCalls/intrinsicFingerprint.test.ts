import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeExtractCalls } from "./analysis.js";

function prepare(root: string, mutation = "") {
  const flow = analyzeExtractCalls({
    root,
    filename: resolve(root, "app.ts"),
    source: 'import {make} from "./factory.ts";export const value=make();',
    extractCalls: { "./factory.ts": ["make"] }
  });
  let step = flow.next();
  while (!step.done) {
    const request = step.value;
    if (request.kind === "resolve")
      step = flow.next(resolve(dirname(request.importer), request.source));
    else if (request.kind === "load")
      step = flow.next(`export const make=()=>"class";${mutation}`);
    else step = flow.next(null);
  }
  return step.value;
}

describe("portable public intrinsic fingerprints", () => {
  it("keeps absolute graph identities private while public sidecar keys relocate", () => {
    const first = prepare("/first/project"),
      second = prepare("/second/project");
    expect(first.mathIntrinsics?.fingerprint).not.toBe(
      second.mathIntrinsics?.fingerprint
    );
    expect(first.arrayMapIntrinsics?.fingerprint).not.toBe(
      second.arrayMapIntrinsics?.fingerprint
    );
    expect(first.fingerprint).toBe(second.fingerprint);
  });
  it("still changes the public contract when native authority is revoked", () => {
    const normal = prepare("/project"),
      mutated = prepare("/project", "Math.max = replacement;");
    expect(normal.mathIntrinsics?.intact).toBe(true);
    expect(mutated.mathIntrinsics?.intact).toBe(false);
    expect(normal.fingerprint).not.toBe(mutated.fingerprint);
  });
});

it("fingerprints precise operation keys even when broad authority is already revoked", () => {
  const named = prepare(
    "/project",
    "Object.defineProperty(Object.prototype,'name',{value:1});"
  );
  const colored = prepare(
    "/project",
    "Object.defineProperty(Object.prototype,'color',{value:1});"
  );
  expect(named.arrayMapIntrinsics).toMatchObject({
    intact: false,
    iterationIntact: true,
    prototypeAbsenceIntact: false,
    prototypeMutationKeys: ["name"]
  });
  expect(colored.arrayMapIntrinsics?.prototypeMutationKeys).toEqual(["color"]);
  expect(named.fingerprint).not.toBe(colored.fingerprint);
});
