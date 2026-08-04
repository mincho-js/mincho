# @mincho-js/transform-runtime

Dependency-free helpers emitted by Mincho transforms.

This package is for generated code. Mincho compiler output may import helpers from `@mincho-js/transform-runtime`, so bundlers must resolve that package from generated `.css.ts` sidecars and transformed component modules. Do not import these helpers from `@mincho-js/css`; they are not user-facing CSS authoring APIs.

## Install

```shell
npm install @mincho-js/transform-runtime

# or
yarn add @mincho-js/transform-runtime

# or
pnpm install @mincho-js/transform-runtime
```

## API

### vx

`vx(value, suffix?)` formats compiler-emitted dynamic CSS custom property values.

```typescript
import { vx } from "@mincho-js/transform-runtime";

vx(undefined); // "var(--c-, )"
vx(false); // "var(--c-, )"
vx(0); // 0
vx(8, "px"); // "8px"
vx(2, "rem"); // "2rem"
vx(50, "%"); // "50%"
```

`null`, `undefined`, and booleans return `"var(--c-, )"` so a missing dynamic value blocks inherited CSS custom properties through a fallback value. This mirrors the safety goal seen in Compiled and StyleX without implying Mincho emits `@property` declarations. Strings and numbers pass through unchanged unless a compiler-emitted one-hole suffix template requests the supported `px`, `%`, or `rem` suffix.

`vx(value, suffix?)` exists only for transform output such as JSX `css` prop dynamic declaration leaves. Application code should keep using `css`, `rules`, `theme`, and related APIs from `@mincho-js/css`.
