# vanilla-extract packages in Mincho source files

Mincho's Babel, esbuild and Vite integrations extract calls imported from
vanilla-extract's styling packages into the same CSS sidecar used for Mincho
styles. These definitions can live in ordinary `.ts` and `.tsx` modules.
Install the vanilla-extract packages you import as dependencies of your project.

```ts
import { css } from "@mincho-js/css";
import { style } from "@vanilla-extract/css";
import { recipe } from "@vanilla-extract/recipes";
import { defineProperties, createSprinkles } from "@vanilla-extract/sprinkles";

const base = css({ padding: "12px" });
const label = style({ fontWeight: "bold" });
const button = recipe({
  base: [base, label],
  variants: { tone: { quiet: { opacity: 0.5 }, loud: { opacity: 1 } } },
});
const properties = defineProperties({
  properties: { display: ["flex", "grid"] },
});
const sprinkles = createSprinkles(properties);

// Definitions run in the sidecar; generated functions accept runtime values.
export const className = (tone: "quiet" | "loud", display: "flex" | "grid") =>
  `${button({ tone })} ${sprinkles({ display })}`;
```

| Import source                            | Extracted definitions                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@vanilla-extract/css`                   | `style`, `styleVariants`, `globalStyle`, `createTheme`, `createGlobalTheme`, `createThemeContract`, `createGlobalThemeContract`, `createVar`, `createGlobalVar`, `fontFace`, `globalFontFace`, `keyframes`, `globalKeyframes`, `layer`, `globalLayer`, `createContainer`, `createViewTransition`, `generateIdentifier` |
| `@vanilla-extract/recipes`               | `recipe`                                                                                                                                                                                                                                                                                                               |
| `@vanilla-extract/sprinkles`             | `defineProperties`, `createSprinkles`, `createNormalizeValueFn`, `createMapValueFn`, and the legacy aliases `createAtomicStyles`, `createAtomsFn`                                                                                                                                                                      |
| `@vanilla-extract/sprinkles/createUtils` | `createNormalizeValueFn`, `createMapValueFn`                                                                                                                                                                                                                                                                           |
| `@mincho-js/css/compat`                  | The vanilla-extract style definitions re-exported by Mincho and `recipe`                                                                                                                                                                                                                                               |

Named imports, aliased imports and namespace calls such as `styles.style(...)`
and `styles["style"](...)` are recognized. Arguments must be evaluable at build
time, as with Mincho's existing extracted calls. The `/* mincho-js-ignore */`
comment also applies to these imports. Arbitrary local aliases, re-exporting
wrapper modules and computed namespace keys are not followed automatically.

Runtime APIs stay in the application: `assignInlineVars` and `setElementVars`
from `@vanilla-extract/dynamic`, as well as `composeStyles`, `assignVars`,
`fallbackVar` and `assertVarName` from `@vanilla-extract/css`. When used inside an
extracted definition, the expression is evaluated with that definition.
Calls to generated recipes, sprinkles, normalizers and mappers also stay at
runtime unless they are dependencies of an extracted style.

The official bundler plugins and internal serialization entry points are not
style definitions. Continue configuring plugins normally. Existing `.css.ts`
files retain their existing processing path, including coexistence with the
official vanilla-extract Vite plugin.
