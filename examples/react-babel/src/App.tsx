import "@examples/shared-component/style.css";
import { SharedExampleCard } from "@examples/shared-component";
import { css } from "@mincho-js/css";
import { styled } from "@mincho-js/react";
import type { CSSProperties, ReactNode } from "react";

import { sharedCardHostClassName } from "./App.css.ts";
import importedDefaultStyle, { importedNamedStyle } from "./staticStyles";

const styleA = css({
  display: "block",
});

function ClassNameForwardingExample({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <section className={className} style={style}>
      {children}
    </section>
  );
}

const BaseComponent = styled.div({
  base: {
    fontWeight: "bold",
  },
});

const Container = styled(BaseComponent, {
  base: {
    backgroundColor: "red",
    padding: "20px",
    margin: "20px",
    borderRadius: "5px",
    color: "white",
    fontFamily: "sans-serif",
  },
  variants: {
    size: {
      small: {
        padding: "10px",
      },
      medium: {
        padding: "20px",
      },
      large: {
        padding: "30px",
      },
    },
    color: {
      red: {
        backgroundColor: "red",
      },
      blue: {
        backgroundColor: "blue",
      },
    },
  },
  compoundVariants: ({ size, color }) => [
    {
      condition: [size.small, color.blue],
      style: {
        color: "green",
      },
    },
    {
      condition: [size.large, color.blue],
      style: {
        color: "yellow",
      },
    },
  ],
  defaultVariants: {
    size: "medium",
    color: "red",
  },
});

function App() {
  return (
    <>
      <Container size="large" color="blue">
        Hello World
      </Container>
      <div css={styleA}>Class-value css prop mode</div>
      <ClassNameForwardingExample css={styleA}>
        Custom component css prop forwarding
      </ClassNameForwardingExample>
      <div css={importedNamedStyle}>Imported named static css prop</div>
      <div css={importedDefaultStyle}>Imported default static css prop</div>
      <div
        className={sharedCardHostClassName}
        css={{
          margin: "20px",
        }}
      >
        <SharedExampleCard />
      </div>
    </>
  );
}

export default App;
