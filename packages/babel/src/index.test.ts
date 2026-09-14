import { describe, expect, it } from "vitest";
import { babelTransform } from "./testUtils/plugin.js";

describe("minchoBabelPlugin", () => {
  it("export default style", () => {
    const { result, code } = babelTransform(`
        import { style } from "@mincho-js/css";

        export default style({
          color: "red",
        });
      `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  }, 10_000);

  it("inside jsx expression", () => {
    const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        function App() {
          return <div class={style({
            color: 'red'
          })}>Hello</div>
        }

        console.log(red);
      `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("hoists inline expression", () => {
    const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const str = \`abc \${style({ color: "red" })}\`;
        console.log(str);
      `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("hoists object property", () => {
    const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const obj = {
          nested: {
            key: style({ color: "red" })
          }
        };
        console.log(obj);
      `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("hoists array member", () => {
    const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const arr = [1, 2, style({ color: "red" }), 4, style({ color: "blue" })];
        console.log(arr);
      `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("extracts style function", () => {
    const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';
        const red = style({ color: "red" });
        console.log(red);
      `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("leaves defineRules call shape untouched", () => {
    const { code } = babelTransform(`
        import { defineRules } from '@mincho-js/css';

        defineRules({
          properties: {
            color: String,
          },
          shortcuts: {
            text: {
              color: 'red',
            },
          },
        });
      `);

    expect(code).toContain("defineRules({");
  });

  it("extracts $mincho function", () => {
    const { result, code } = babelTransform(`
        import { style, mincho$ } from '@mincho-js/css';
        const red = mincho$(() => {
          return 2 + 2;
        });
        console.log(red);
      `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("multiple variable declarators in one declaration", () => {
    const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const red = style({ color: 'red' }),
        blue = style({ color: 'blue' }),
        green = style({ color: 'green' });

      console.log(red, blue, green);
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("move bindings along with extracted style", () => {
    const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';
      const redColor = 'red';
      const red = style({ color: redColor });
      console.log(red);
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("inside block scope", () => {
    const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';
      {
        const red = style({ color: 'red' });
        console.log(red);
      }
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("already exported", () => {
    const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      export const red = style({ color: 'red' });
      console.log(red);
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  // doesn't work
  it("hoisting same variable name in different scope", () => {
    const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const red = style({ color: 'red' });
      console.log(red);

      function SomeComponent() {
        const red = style({ color: 'blue' });
        console.log(red)
      }
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  // it("array pattern hoisting", () => {
  //   const { result, code } = babelTransform(`
  //   import { createTheme } from '@mincho-js/css';

  //   const [themeClass, vars] = createTheme({
  //     colors: {
  //       brand: 'red'
  //     }
  //   });
  //   console.log(themeClass, vars);
  // `);

  //   expect(result).toMatchSnapshot();
  //   expect(code).toMatchSnapshot();
  // });

  it("same binding in multiple declarations", () => {
    const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const color = 'red';
      const foreground = style({ color });
      const background = style({ background: color });

      console.log(foreground, background)
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("binding ordering", () => {
    const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const color = 'red';
      const red = style({ color });
      const longClass = \`abc \${red}\`;
      console.log(longClass)
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("nested bindings", () => {
    const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const theme = { color: 'red' };
      const themeColor = theme.color;
      const color = themeColor;

      const red = style({ color });
      console.log(red)
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  // it("css variables", () => {
  //   const { result, code } = babelTransform(`
  //   import { style, createVar } from '@mincho-js/css';

  //   const colorVar = createVar();

  //   const red = style({
  //     color: 'red',
  //     vars: {
  //       [colorVar]: 'red'
  //     }
  //   });
  //   console.log(red)
  // `);

  //   expect(result).toMatchSnapshot();
  //   expect(code).toMatchSnapshot();
  // });

  it("global styles", () => {
    const { result, code } = babelTransform(`
      import { globalStyle } from '@mincho-js/css';

      globalStyle('html, body', {
        color: 'red',
      });
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("arrow function bindings", () => {
    {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        const utility = { gap: (size) => ({ gap: size }) }
        const red = style({ ...utility.gap('10px') });
        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    }

    {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        const getStyles = (color) => ({ color })
        const red = style({ ...getStyles('red') });
        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    }
  });

  it("function declaration bindings", () => {
    {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        function getColor() { return 'red' }
        const red = style({ color: getColor() });
        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    }

    {
      const { result, code } = babelTransform(`
        import { style } from '@mincho-js/css';

        function getStyles(color) { return { color } }
        const red = style({ ...getStyles('red') });
        console.log(red);
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    }
  });

  it("mincho-ignore doesn't extract expression", () => {
    const { result, code } = babelTransform(`
      import { style } from '@mincho-js/css';

      const red = /* mincho-ignore */ style({ color: "red" });
      console.log(red);
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("react styled components get converted to runtime", () => {
    const { result, code } = babelTransform(`
      import { styled } from '@mincho-js/react';

      const Button = styled("button", {
        base: { color: 'red' }
      })
      const Link = styled.a({
        base: { color: 'blue' }
      })
      console.log(Button, Link)
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("non-Mincho styled calls are ignored", () => {
    const { result, code } = babelTransform(`
      import { styled } from '@emotion/styled';

      const Button = styled("button", {
        color: 'red'
      })
      const Link = styled.a({
        color: 'blue'
      })
      console.log(Button, Link)
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });

  it("mincho-ignore on parent node", () => {
    const { result, code } = babelTransform(`
      import { globalStyle } from '@mincho-js/css';

      /* mincho-ignore */ globalStyle("html", { color: 'red' })
    `);

    expect(result).toMatchSnapshot();
    expect(code).toMatchSnapshot();
  });
});
