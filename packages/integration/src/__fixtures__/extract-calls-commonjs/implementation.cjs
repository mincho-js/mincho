const { recipe } = require("@vanilla-extract/recipes");
const { create } = require("./helper.cjs");

function makeRecipe(options) {
  return recipe(options);
}

exports.makeStyle = (rule) => create(rule);
exports.makeRecipe = makeRecipe;

exports.localClassName = makeRecipe({ base: { color: "orchid" } })();
