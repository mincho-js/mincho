import { defineRules } from "@mincho-js/css";

const context = {
  palette: {
    resolve() {
      return "rebeccapurple";
    }
  }
};

const config = {
  context,
  properties: {
    color: true
  }
};
const { css, preset } = defineRules(config);

export const shared = css({
  color: context.palette.resolve()
});
export { preset };
