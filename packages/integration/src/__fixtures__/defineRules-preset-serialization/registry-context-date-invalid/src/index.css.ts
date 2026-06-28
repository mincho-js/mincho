import { defineRules } from "@mincho-js/css";

const context = {
  color: "rebeccapurple",
  createdAt: new Date(0)
};

const config = {
  context,
  properties: {
    color: true
  }
};
const { css, preset } = defineRules(config);

export const shared = css({
  color: context.color
});
export { preset };
