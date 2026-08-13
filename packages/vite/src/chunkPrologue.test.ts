import { describe, expect, it } from "vitest";
import { findChunkDirectivePrologueEnd } from "./chunkPrologue.js";

describe("findChunkDirectivePrologueEnd", () => {
  it("preserves BOM, hashbang, banners, comments, CRLF, and every directive", () => {
    const source =
      '\uFEFF#!/usr/bin/env node\r\n/* banner */\r\n\r\n"use client"; // client\r\n"use strict" /* strict */;\r\nmodule.exports = {};';

    expect(source.slice(0, findChunkDirectivePrologueEnd(source))).toBe(
      '\uFEFF#!/usr/bin/env node\r\n/* banner */\r\n\r\n"use client"; // client\r\n"use strict" /* strict */;\r\n'
    );
  });

  it("keeps a leading banner before injected statements without directives", () => {
    const source = "/* banner */\n\nexport const value = true;";

    expect(source.slice(0, findChunkDirectivePrologueEnd(source))).toBe(
      "/* banner */\n\n"
    );
  });

  it("does not treat a continued string expression as a directive", () => {
    const source = '"not a directive"\n.concat(value);';

    expect(findChunkDirectivePrologueEnd(source)).toBe(0);
  });
});
