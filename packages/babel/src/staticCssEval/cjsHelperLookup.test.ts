import { describe, expect, it } from "vitest";
import { inspectCommonJs } from "../commonjs/esm.js";

const createBinding = `function (o, m, k, k2) {
  if (k2 === undefined) k2 = k;
  o[k2] = m[k];
}`;
const exportStar = `function (m, exports) {
  for (var p in m)
    if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p))
      __createBinding(exports, m, p);
}`;

function inspect(helper: string) {
  return inspectCommonJs(
    `
    const forged = function () {};
    var __createBinding = ${createBinding};
    var __exportStar = ${helper};
    __exportStar(require("dep"), exports);
  `,
    "helpers.cjs"
  );
}

describe("TypeScript helper binding verification", () => {
  it.each([
    `forged || ${exportStar}`,
    `forged && ${exportStar}`,
    `forged + ${exportStar}`,
    `forged ? ${exportStar} : forged`,
    `(${exportStar}, forged)`,
    `async ${exportStar}`,
    exportStar.replace("function", "function*"),
    `Object.create ? ${exportStar} : forged`
  ])(
    "rejects an initializer that can select a different helper: %s",
    (helper) => {
      expect(inspect(helper).diagnostics).toContainEqual(
        expect.stringContaining("__exportStar")
      );
    }
  );

  it.each([
    exportStar,
    `(this && this.__exportStar) || ${exportStar}`,
    `(this && this.__exportStar) || (Object.create ? ${exportStar} : ${exportStar})`
  ])("recognizes direct and TypeScript-emitted helpers: %s", (helper) => {
    expect(inspect(helper).diagnostics).toEqual([]);
    expect(inspect(helper).stars).toEqual(["dep"]);
  });
  it.each(["async function", "function*"])(
    "rejects %s helper declarations",
    (prefix) => {
      const source = `var __createBinding = ${createBinding}; ${exportStar.replace("function", `${prefix} __exportStar`)} __exportStar(require("dep"), exports);`;
      expect(inspectCommonJs(source, "helpers.cjs").diagnostics).toContainEqual(
        expect.stringContaining("__exportStar")
      );
    }
  );
});
