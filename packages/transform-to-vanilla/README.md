# @mincho-js/transform-to-vanilla

CSS in JS syntax converter for [Vanilla Extract](https://github.com/vanilla-extract-css/vanilla-extract)

## Install

```shell
npm install @mincho-js/transform-to-vanilla

# or
yarn add @mincho-js/transform-to-vanilla

# or
pnpm install @mincho-js/transform-to-vanilla
```

## API

### transform

Convert to a vanilla extract object according to the [CSS Literals](https://github.com/mincho-js/working-group/blob/main/text/000-css-literals.md) and [CSS Nesting](https://github.com/mincho-js/working-group/blob/main/text/001-css-nesting.md) RFCs.

```typescript
import { transform } from "@mincho-js/transform-to-vanilla";

transform(styleObj);
transform(styleObj, context);
```

### TransformContext

The context type of the `transform`.

```typescript
import type { TransformContext } from "@mincho-js/transform-to-vanilla";

const initTransformContext: TransformContext = {
  result: {},
  basedKey: "",
  parentSelector: "",
  parentAtRules: {
    "@media": "",
    "@supports": "",
    "@container": "",
    "@layer": ""
  },
  propertyReference: {},
  variantMap: {},
  variantReference: {}
};
```
