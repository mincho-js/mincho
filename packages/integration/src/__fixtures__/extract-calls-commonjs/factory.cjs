const implementation = require("./implementation.cjs");

Object.defineProperty(exports, "defineStyle", {
  enumerable: true,

  get: function () { return implementation.makeStyle; }
});
Object.defineProperty(exports, "makeRecipe", {
  enumerable: true,

  get: function () { return implementation.makeRecipe; }
});
