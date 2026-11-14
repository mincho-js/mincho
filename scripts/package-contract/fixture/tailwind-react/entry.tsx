import {
  css,
  styled,
  rules,
  cx,
  themeClass
} from "@mincho-js/preset-tailwind-react";

const Button = styled.button({
  base: { text: "white", px: 2, py: 1 },
  variants: { tone: { solid: { bg: "blue-500" }, soft: { bg: "blue-100" } } },
  defaultVariants: { tone: "solid" }
});
const Link = styled("a", { base: { text: "blue-700", px: 1 } });
const parent = rules({ base: { p: 1 } });
const extended = rules.extends(parent, { base: { rounded: true } });
const labels = rules.multiple({ label: { base: { font: "bold" } } });
const labelClass = css({ text: "blue-700" });

export function App() {
  return (
    <main className={themeClass} css={{ p: 2, bg: "slate-50" }}>
      <Button id="button" tone="solid" css={{ px: 3 }}>
        Grow
      </Button>
      <Link href="/docs">Documentation</Link>
      <span className={cx(extended(), labels.label(), labelClass)}>Label</span>
    </main>
  );
}

export { vars } from "@mincho-js/preset-tailwind-react";
