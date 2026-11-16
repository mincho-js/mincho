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
import { systemClass } from "@mincho-js/preset-theme-ui";

const { Button, Heading, Link } = system.components({
  buttons: {
    primary: {
      bg: "primary",
      color: "background",
      fontWeight: "heading",
      px: 2,
      py: 1
    },
    secondary: { variant: "buttons.primary", bg: "secondary" }
  },
  text: { display: { color: "primary" } }
});
const generic = createComponents(system, {
  text: { accent: { color: "secondary" } }
});
const Note = styled.aside({ base: { p: 1, color: "text" } });
const parent = rules({ base: { p: 1 } });
const extended = rules.extends(parent, { base: { color: "text" } });
const labels = system.rules.multiple({
  label: { base: { fontWeight: "heading" } }
});
const labelClass = css({ color: "primary" });
const baseClass = base.css({ color: "text" });
const darkClass = dark.css({ color: "text" });

export function App() {
  return (
    <main className={systemClass} css={{ p: 2, bg: "background" }}>
      <Heading as="h1" id="heading" variant="display">
        Theme UI heading
      </Heading>
      <Button id="secondary" variant="secondary" css={{ px: 3 }}>
        Continue
      </Button>
      <Button id="root-variant" variant="text.display">
        Root variant
      </Button>
      <Link href="/docs">Documentation</Link>
      <generic.Text id="generic" variant="accent">
        Generic factory
      </generic.Text>
      <Note id="recipe" className={cx(extended(), labels.label(), labelClass)}>
        Recipe
      </Note>
      <span className={baseClass}>Base definition</span>
      <span className={darkClass}>Dark definition</span>
    </main>
  );
}

export { systemVars as vars } from "@mincho-js/preset-theme-ui";
