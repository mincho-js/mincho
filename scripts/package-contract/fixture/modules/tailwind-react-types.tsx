import { styled, css, rules } from "@mincho-js/preset-tailwind-react";
import { extractCalls } from "@mincho-js/preset-tailwind-react/config";
import type { CSSProperties } from "react";

const calls: readonly string[] =
  extractCalls["@mincho-js/preset-tailwind-react"];
void calls;

export const inline = (
  <div
    css={{
      display: { base: "flex", _sm: "inline-flex" },
      bg: "blue-500",
      px: 3
    }}
  />
);
export const className = <div className={css({ text: "white", p: 2 })} />;
// @ts-expect-error The selected JSX runtime retains the preset vocabulary.
export const invalidToken = <div css={{ bg: "missing-token" }} />;
// @ts-expect-error Theme UI's scoped tokens do not augment Tailwind JSX.
export const themeUiColor = <div css={{ color: "primary" }} />;
// @ts-expect-error The selected JSX runtime rejects misspelled shortcuts.
export const invalidProperty = <div css={{ paddingXTypo: 2 }} />;

const Badge = styled.span({
  base: { rounded: true, px: 2 },
  variants: {
    tone: { success: { bg: "emerald-100" }, info: { bg: "sky-100" } }
  }
});
export const badge = <Badge tone="success" css={{ py: 1 }} />;
// @ts-expect-error Styled components retain their variant names.
export const invalidVariant = <Badge tone="missing" />;
// @ts-expect-error Styled definitions retain their token vocabulary.
styled.span({ base: { bg: "missing-token" } });

const Link = styled("a", { base: { text: "blue-700" } });
export const link = <Link href="/docs" css={{ px: 1 }} />;
const recipe = rules({ variants: { size: { large: { py: 3 } } } });
const selected: string = recipe({ size: "large" });
void selected;

const Forwarding = (props: { className?: string; style?: CSSProperties }) => (
  <div {...props} />
);
export const forwarding = <Forwarding css={{ px: 2 }} />;
const Plain = (_props: { label: string }) => null;
// @ts-expect-error Components must accept className and style to receive css.
export const plain = <Plain label="label" css={{ px: 2 }} />;
