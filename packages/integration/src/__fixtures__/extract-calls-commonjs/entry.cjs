const { defineStyle, makeRecipe } = require("./factory.cjs");
const { unrelated } = require("./helper.cjs");

const className = defineStyle({ color: "tomato" });
const button = makeRecipe({
  base: className,
  variants: { tone: { quiet: { opacity: 0.5 }, loud: { opacity: 1 } } }
});

exports.localClassName = require("./implementation.cjs").localClassName;
exports.className = className;
exports.render = (tone) => [unrelated, button({ tone })].join(" ");
