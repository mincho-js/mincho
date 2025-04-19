import { PluginObj, transformSync } from "@babel/core";
import { transformCallExpression } from "@/transforms/callExpression.js";
import postprocess from "@/transforms/postprocess.js";
import preprocess from "@/transforms/preprocess.js";
import { PluginOptions, PluginState } from "@/types.js";
import { styledComponentPlugin } from "@/styled.js";

export function minchoBabelPlugin(): PluginObj<PluginState> {
  return {
    name: "mincho-babel-plugin",
    visitor: {
      Program: {
        enter: preprocess,
        exit: postprocess
      },
      CallExpression: transformCallExpression
    }
  };
}

export { styledComponentPlugin as minchoStyledComponentPlugin } from "@/styled.js";
export type { PluginOptions } from "@/types.js";

// == Tests ====================================================================
// Ignore errors when compiling to CommonJS.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
if (import.meta.vitest) {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore error TS1343: The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020', 'es2022', 'esnext', 'system', 'node16', or 'nodenext'.
  const { describe, it, expect } = import.meta.vitest;

  function babelTransform(code: string) {
    const options: PluginOptions = { result: ["", ""] };
    const result = transformSync(code, {
      plugins: [[minchoBabelPlugin(), options], [styledComponentPlugin()]],
      presets: ["@babel/preset-typescript"],
      filename: "test.tsx"
    });

    if (result === null || result.code === null) {
      throw new Error("Failed to transform code");
    }

    return { result: options.result, code: result.code };
  }

  describe.concurrent("minchoBabelPlugin", () => {
    it("export default style", () => {
      const { result, code } = babelTransform(`
        import { style } from "@mincho-js/css";

        export default style({
          color: "red",
        });
      `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });

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

    // it("react styled components get converted to recipe", () => {
    //   const { result, code } = babelTransform(`
    //   import { styled } from '@macaron-css/react';

    //   const Button = styled("button", {
    //     base: { color: 'red' }
    //   })
    //   console.log(Button)
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    // it("solid styled components get converted to recipe", () => {
    //   const { result, code } = babelTransform(`
    //   import { styled } from '@macaron-css/solid';

    //   const Button = styled("button", {
    //     base: { color: 'red' }
    //   })
    //   console.log(Button)
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    // it("leading comments of `styled` get passed to recipe", () => {
    //   const { result, code } = babelTransform(`
    //   import { styled } from '@macaron-css/solid';
    //   import {macaron$} from '@mincho-js/css';

    //   const fn = () => {
    //     const arr = [1,2]
    //     for (const _ of arr) {
    //       const Button = /* macaron-ignore */ styled("button", {
    //         base: { color: _ }
    //       })
    //     }
    //     return Button;
    //   }
    //   const test = macaron$(() => {
    //     console.log(fn())
    //     return "test"
    //   })
    //   console.log(test)
    // `);

    //   expect(result).toMatchSnapshot();
    //   expect(code).toMatchSnapshot();
    // });

    it("mincho-ignore on parent node", () => {
      const { result, code } = babelTransform(`
      import { globalStyle } from '@mincho-js/css';

      /* mincho-ignore */ globalStyle("html", { color: 'red' })
    `);

      expect(result).toMatchSnapshot();
      expect(code).toMatchSnapshot();
    });
  });
}
