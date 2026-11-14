import preset = require("@mincho-js/preset-theme-ui-react");
import config = require("@mincho-js/preset-theme-ui-react/config");
import type { JSX } from "@mincho-js/preset-theme-ui-react/jsx-runtime";
import type { JSX as DevJSX } from "@mincho-js/preset-theme-ui-react/jsx-dev-runtime";

const calls: readonly string[] =
  config.extractCalls["@mincho-js/preset-theme-ui-react"];
const props: JSX.IntrinsicElements["button"] = { css: { color: "primary" } };
const developmentProps: DevJSX.IntrinsicElements["button"] = props;
const className: string = preset.css({ color: "primary", p: 2 });
const components = preset.system.components({
  buttons: { primary: { bg: "primary", color: "background" } }
});
const Button: typeof components.Button = components.Button;
void [calls, developmentProps, className, Button];
