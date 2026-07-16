import "@examples/shared-component/style.css";
import { SharedExampleCard } from "@examples/shared-component";
import { css } from "@mincho-js/css";
import { type ReactNode, useState } from "react";
import reactLogo from "./assets/react.svg";
import importedDefaultStyle, { importedNamedStyle } from "./staticStyles";
import viteLogo from "/vite.svg";

const styleA = css({
  display: "block",
});

const cardClassName = "card";
const logoClassName = "logo";
const reactLogoClassName = `${logoClassName} react`;
const readTheDocsClassName = "read-the-docs";
const sharedCardContainerClassName = `${cardClassName} shared-card-consumer`;

function ClassNameForwardingExample({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <section className={className}>{children}</section>;
}

function App() {
  const [count, setCount] = useState(0);

  return (
    <>
      <div>
        <a href="https://vitejs.dev" target="_blank">
          <img src={viteLogo} className={logoClassName} alt="Vite logo" />
        </a>
        <a href="https://react.dev" target="_blank">
          <img src={reactLogo} className={reactLogoClassName} alt="React logo" />
        </a>
      </div>
      <h1>Vite + React</h1>
      <div className={cardClassName}>
        <button onClick={() => setCount((count) => count + 1)}>
          count is {count}
        </button>
        <p>
          Edit <code>src/App.tsx</code> and save to test HMR
        </p>
      </div>
      <div css={styleA}>Class-value css prop mode</div>
      <ClassNameForwardingExample css={styleA}>
        Custom component css prop forwarding
      </ClassNameForwardingExample>
      <div css={importedNamedStyle}>Imported named static css prop</div>
      <div css={importedDefaultStyle}>Imported default static css prop</div>
      <div
        className={sharedCardContainerClassName}
        css={{
          marginTop: "2em",
        }}
      >
        <SharedExampleCard />
      </div>
      <p className={readTheDocsClassName}>
        Click on the Vite and React logos to learn more
      </p>
    </>
  );
}

export default App
