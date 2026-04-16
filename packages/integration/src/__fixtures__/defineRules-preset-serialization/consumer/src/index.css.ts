import "__DEFINE_RULES_PRESET_SPECIFIER__/shared-component.css";
import {
  css,
  shared as importedShared
} from "__DEFINE_RULES_PRESET_SPECIFIER__";

export const shared = css({
  color: "rebeccapurple",
  display: "flex"
});

export const consumerOnly = css({
  padding: 13,
  margin: 11
});

export const mixed = css([
  {
    color: "rebeccapurple",
    display: "flex"
  },
  {
    padding: 13
  }
]);

export { importedShared };
