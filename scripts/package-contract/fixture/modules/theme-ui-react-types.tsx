/** @jsxImportSource @mincho-js/preset-theme-ui-react */
import {
  base,
  system,
  dark,
  css,
  cx,
  rules,
  styled,
  createComponents
} from "@mincho-js/preset-theme-ui-react";
import { extractCalls } from "@mincho-js/preset-theme-ui-react/config";
import type { CSSProperties } from "react";

const calls: readonly string[] =
  extractCalls["@mincho-js/preset-theme-ui-react"];
void calls;

export const element = (
  <button
    css={{ color: "primary", bg: "background", p: { base: 2, _sm: 3 } }}
  />
);
export const readonlyArray = <div css={[{ p: 2 }] as const} />;
// @ts-expect-error Theme UI color tokens are scoped to this runtime.
export const wrongColor = <div css={{ color: "blue-500" }} />;
// @ts-expect-error Unknown properties are not Theme UI shortcuts.
export const wrongProperty = <div css={{ paddingXTypo: 2 }} />;

const { Button, Heading } = system.components({
  buttons: {
    primary: { bg: "primary", color: "background" },
    secondary: { variant: "buttons.primary", bg: "secondary" }
  },
  text: { display: { color: "primary" } }
});
export const button = <Button variant="secondary" css={{ px: 3 }} />;
export const rootVariant = <Button variant="text.display" />;
export const heading = <Heading as="h1" variant="display" />;
// @ts-expect-error Component variants retain their declared names.
export const wrongVariant = <Button variant="missing" />;

const generic = createComponents(system, {
  text: { accent: { color: "secondary" } }
});
export const genericText = <generic.Text variant="accent" />;
const Badge = styled.span({
  base: { px: 2 },
  variants: { tone: { success: { color: "primary" } } }
});
export const badge = <Badge tone="success" css={{ py: 1 }} />;
// @ts-expect-error Styled components retain declared recipe variants.
export const wrongRecipe = <Badge tone="missing" />;
// @ts-expect-error Styled inputs retain native Theme UI token constraints.
styled.span({ base: { color: "blue-500" } });

base.css({ color: "text" });
dark.css({ color: "text" });
const factory = rules({ base: { px: 2 } });
const className: string = cx(factory(), css({ color: "primary" }));
void className;

const Forwarding = (props: { className?: string; style?: CSSProperties }) => (
  <div {...props} />
);
export const forwarding = <Forwarding css={{ px: 2 }} />;
const Plain = (_props: { label: string }) => null;
// @ts-expect-error Components must forward className and style for css.
export const plain = <Plain label="label" css={{ px: 2 }} />;
