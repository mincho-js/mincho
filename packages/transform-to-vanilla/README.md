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

### collectStyleDeclarations()

`collectStyleDeclarations()` walks a Mincho style object and returns source-order declarations instead of a Vanilla Extract object. Each entry contains the normalized condition tuple, the expanded property, and the raw value.

```typescript
import {
  collectStyleDeclarations,
  type CollectedStyleDeclaration,
  type ConditionAliasMap,
  type ConditionAliasValue,
  type NormalizedCondition
} from "@mincho-js/transform-to-vanilla";

const conditions = {
  _tablet: "screen and (min-width: 768px)",
  _desktop: {
    "@media": "screen and (min-width: 1024px)",
    selector: "&[data-layout=wide]"
  }
} satisfies ConditionAliasMap;

const declarations = collectStyleDeclarations(
  {
    color: {
      base: "black",
      _tablet: "blue"
    },
    _desktop: {
      fontSize: 20
    }
  },
  { conditions }
) satisfies CollectedStyleDeclaration[];

type DeclarationCondition = NormalizedCondition;
type AliasValue = ConditionAliasValue;
```

`ConditionAliasMap` is keyed by underscore aliases, such as `_tablet`. A string `ConditionAliasValue` is a media condition. Object values may use `"@layer"`, `"@supports"`, `"@media"`, `"@container"`, and `selector`.

The collector is meant for runtimes, build plugins, analyzers, and code generators that need declaration metadata before CSS emission. It is reusable and is not tied to one higher-level API.
