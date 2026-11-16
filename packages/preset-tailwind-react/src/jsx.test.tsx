import type { CSSProperties, JSX as ReactJSX } from "react";
import type { css } from "@mincho-js/preset-tailwind";
import type { CssPropJSX } from "@mincho-js/react";
import type { JSX } from "./jsx-runtime.js";
import type { JSX as DevJSX } from "./jsx-dev-runtime.js";
import type { styled as styledFactory } from "./index.js";
import { expectTypeOf, it } from "vitest";

export function typeExamples(styled: typeof styledFactory) {
  const Button = styled.button({
    base: { px: 3, py: 2, font: "bold" },
    variants: { tone: { info: { bg: "blue-500" } } }
  });
  const Link = styled("a", { base: { text: "blue-700" } });

  <button
    css={[
      {
        bg: { base: "blue-500", _hover: "blue-700" },
        text: "white",
        font: "bold",
        py: 2,
        px: 3
      },
      "rounded"
    ]}
  />;
  <Button tone="info" css={{ px: 4 }} />;
  <Link href="/" css={{ px: 1 }} />;

  // @ts-expect-error Polymorphic styled components retain scoped CSS tokens.
  <Link href="/" css={{ bg: "missing-color-token" }} />;

  // @ts-expect-error The scoped JSX source accepts only defined font tokens.
  <button css={{ font: "missing-font-token" }} />;

  // @ts-expect-error Unknown utility aliases are not CSS properties.
  <button css={{ paddingXTypo: 3 }} />;

  // @ts-expect-error Styled components keep their declared variant names.
  <Button tone="missing" />;

  // @ts-expect-error Styled factories use the same Tailwind token vocabulary.
  styled.button({ base: { font: "missing-font-token" } });

  function Label(props: {
    className?: string;
    style?: CSSProperties;
    children?: ReactJSX.Element;
  }) {
    return (
      <span className={props.className} style={props.style}>
        {props.children}
      </span>
    );
  }

  <Label css={{ px: 2 }} />;

  function WithoutClassName(props: { title: string }) {
    return <span>{props.title}</span>;
  }

  // @ts-expect-error Components without className cannot receive compiled CSS.
  <WithoutClassName title="Label" css={{ px: 2 }} />;
}

it("scopes preset CSS props to both JSX entry points", () => {
  expectTypeOf<JSX.IntrinsicElements["button"]>().toEqualTypeOf<
    DevJSX.IntrinsicElements["button"]
  >();
  expectTypeOf<JSX.IntrinsicElements["button"]>().toEqualTypeOf<
    CssPropJSX.IntrinsicElements<typeof css>["button"]
  >();

  type ForwardingProps = { className?: string; style?: CSSProperties };
  type Component = (props: ForwardingProps) => ReactJSX.Element;

  expectTypeOf<
    JSX.LibraryManagedAttributes<Component, ForwardingProps>
  >().toEqualTypeOf<
    CssPropJSX.LibraryManagedAttributes<Component, ForwardingProps, typeof css>
  >();
  expectTypeOf<ReactJSX.IntrinsicElements["button"]>().not.toHaveProperty(
    "css"
  );
});
