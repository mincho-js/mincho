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
  it("stops at an unterminated quoted string reaching end of source", () => {
    const source = '/* banner */ "unterminated';
    expect(findChunkDirectivePrologueEnd(source)).toBe(source.indexOf('"'));
  });

  it("treats U+2028 between statements as a line terminator", () => {
    const source = '"use client"\u2028export const value = true;';
    expect(source.slice(0, findChunkDirectivePrologueEnd(source))).toBe(
      '"use client"\u2028'
    );
  });

  it("stops at a quoted string containing U+2028", () => {
    expect(findChunkDirectivePrologueEnd('"use\u2028client";')).toBe(0);
  });

  it.each(["in", "instanceof"])(
    "keeps the standalone %s keyword in the string expression",
    (keyword) => {
      expect(findChunkDirectivePrologueEnd(`"value"\n${keyword} object;`)).toBe(
        0
      );
      const source = `"use client"\n${keyword}Value();`;
      expect(source.slice(0, findChunkDirectivePrologueEnd(source))).toBe(
        '"use client"\n'
      );
    }
  );
});
