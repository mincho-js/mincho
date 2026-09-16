import { style, type StyleRule } from "@vanilla-extract/css";

export function create(rule: StyleRule) {
  return style({ ...rule, borderWidth: "3px", borderStyle: "solid" });
}

export const unrelated = style({ outlineStyle: "dotted" });
