const { style } = require("@vanilla-extract/css");

exports.create = function create(rule) {
  return style({ ...rule, borderWidth: "3px", borderStyle: "solid" });
};

exports.unrelated = style({ outlineStyle: "dotted" });
