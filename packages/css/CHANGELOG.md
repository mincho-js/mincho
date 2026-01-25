# @mincho-js/css

## 0.3.0

### Minor Changes

- [#267](https://github.com/mincho-js/mincho/pull/267) [`743384f`](https://github.com/mincho-js/mincho/commit/743384fe107bc2ce523f3b1879690e8e81dfdc24) Thanks [@black7375](https://github.com/black7375)! - **theme**
  - Add `theme()` `this.fallbackVar()` API

- [#219](https://github.com/mincho-js/mincho/pull/219) [`90cde80`](https://github.com/mincho-js/mincho/commit/90cde801cc0133649869bfed9c2e053aa600f6db) Thanks [@black7375](https://github.com/black7375)! - **Compatibility**
  - Separate vanilla extract API to `./compat` entry point for backward compatibility.

- [#227](https://github.com/mincho-js/mincho/pull/227) [`60ebee5`](https://github.com/mincho-js/mincho/commit/60ebee56170b3b683b72eb721fdd26bfc46ce338) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `css.with()` API

- [#271](https://github.com/mincho-js/mincho/pull/271) [`50145b3`](https://github.com/mincho-js/mincho/commit/50145b3eca703e9884113b58eecd0c6ecb8631d3) Thanks [@black7375](https://github.com/black7375)! - **theme**
  - Add `theme()` `this.raw()` API

- [#242](https://github.com/mincho-js/mincho/pull/242) [`aafcd1c`](https://github.com/mincho-js/mincho/commit/aafcd1c4380d6778f7ee1864c08a56f46944ae91) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `rules.with()` API

- [#273](https://github.com/mincho-js/mincho/pull/273) [`1bb5010`](https://github.com/mincho-js/mincho/commit/1bb50106844d162d26f1f470ef0cae0565461708) Thanks [@Jeong-jj](https://github.com/Jeong-jj)! - **rules - compat**
  - Add `recipe` in the compat layer.
  - Separate `rules` implementation to `compat-impl.ts` to support compound object variants in `recipe`.

- [#246](https://github.com/mincho-js/mincho/pull/246) [`d9445d5`](https://github.com/mincho-js/mincho/commit/d9445d541aae580053755bfc3a5f9e07620241d0) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `selector()` utility for computed property names

- [#272](https://github.com/mincho-js/mincho/pull/272) [`4a185b4`](https://github.com/mincho-js/mincho/commit/4a185b470a8d24ecc6badcb46ea4c0408e486a07) Thanks [@black7375](https://github.com/black7375)! - **theme**
  - Add `theme()` `this.fallbackVar()` API

- [#265](https://github.com/mincho-js/mincho/pull/265) [`6482954`](https://github.com/mincho-js/mincho/commit/6482954eb32b6a69037d45ba1f4f0da5b80a411c) Thanks [@black7375](https://github.com/black7375)! - **theme**
  - Add `theme()` base usage and reference variables

- [#232](https://github.com/mincho-js/mincho/pull/232) [`c268326`](https://github.com/mincho-js/mincho/commit/c268326ae498f7c2d1f0504d517fd4d340a1169f) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `rules.raw()` API

- [#222](https://github.com/mincho-js/mincho/pull/222) [`ee6e517`](https://github.com/mincho-js/mincho/commit/ee6e51736f26effa8bcb72d8d5cd907c2de629d8) Thanks [@black7375](https://github.com/black7375)! - **css**
  - Add `css.multiple()` API

- [#176](https://github.com/mincho-js/mincho/pull/176) [`6f7b980`](https://github.com/mincho-js/mincho/commit/6f7b9801c216a3ae4d7a2359a78bbad6427aa63b) Thanks [@Jeong-jj](https://github.com/Jeong-jj)! - **rules**
  - Add `rules.multiple()` API

- [#273](https://github.com/mincho-js/mincho/pull/273) [`ba7f2b6`](https://github.com/mincho-js/mincho/commit/ba7f2b608a402a457be00d39c6f1fb6931c80cb4) Thanks [@Jeong-jj](https://github.com/Jeong-jj)! - **css - compat**
  - Add `styleVariants` in the compat layer.
  - Separate `css.multiple` implementation to `compat-impl.ts` to support mapping callback in `styleVariants`.

### Patch Changes

- [#209](https://github.com/mincho-js/mincho/pull/209) [`df91f14`](https://github.com/mincho-js/mincho/commit/df91f148cf4c0db6a19f544fb993943cc1f50a70) Thanks [@black7375](https://github.com/black7375)! - **Types**
  - Add `VariantStyle` type for constrained variant styles
  - Allow nested selector in `globalCss` function

- [#249](https://github.com/mincho-js/mincho/pull/249) [`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189) Thanks [@black7375](https://github.com/black7375)! - **package**
  - Achieve all [Are the types wrong](https://github.com/arethetypeswrong/arethetypeswrong.github.io) using [vite-plugin-dts-build's dual mode](https://github.com/black7375/vite-plugin-dts-build#dual-module-support).

- [#252](https://github.com/mincho-js/mincho/pull/252) [`089a50c`](https://github.com/mincho-js/mincho/commit/089a50c45d6807f6705acdf1165700fbb0dd7b14) Thanks [@black7375](https://github.com/black7375)! - **export**
  - `PropDefinitionOutput` type
- Updated dependencies [[`9699f0d`](https://github.com/mincho-js/mincho/commit/9699f0d9628ec431f49dda9ef329d58516794189), [`0b49f8a`](https://github.com/mincho-js/mincho/commit/0b49f8a4a617273bd300879ab930d2303e53192d)]:
  - @mincho-js/transform-to-vanilla@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [[`1c89ca9`](https://github.com/mincho-js/mincho/commit/1c89ca943c9d1495230145d47cf810d820aeddbb)]:
  - @mincho-js/transform-to-vanilla@0.2.2

## 0.2.1

### Patch Changes

- Updated dependencies [[`98a9c93`](https://github.com/mincho-js/mincho/commit/98a9c9335f84407717cd5fd7d62ce6c6070af284)]:
  - @mincho-js/transform-to-vanilla@0.2.1

## 0.2.0

### Minor Changes

- [#182](https://github.com/mincho-js/mincho/pull/182) [`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98) Thanks [@black7375](https://github.com/black7375)! - **Big Changes**
  - co-location: [@sangkukbae](https://github.com/sangkukbae)'s work, It's still experimental.
  - packages: `node16` supports

### Patch Changes

- Updated dependencies [[`d840ee2`](https://github.com/mincho-js/mincho/commit/d840ee2979fe23a0ddd97b9e182638b94ccf0d98)]:
  - @mincho-js/transform-to-vanilla@0.2.0

## 0.1.0

### Minor Changes

- [#164](https://github.com/mincho-js/mincho/pull/164) [`69b3b39`](https://github.com/mincho-js/mincho/commit/69b3b3990e3507da43ee68058a2d02ee28aef26a) Thanks [@black7375](https://github.com/black7375)! - Support `rules` known as variants

### Patch Changes

- [#167](https://github.com/mincho-js/mincho/pull/167) [`8cb8a01`](https://github.com/mincho-js/mincho/commit/8cb8a01e378ade3a881098e65f57509eaef0c8c2) Thanks [@dependabot](https://github.com/apps/dependabot)! - update dependencies

- Updated dependencies [[`69b3b39`](https://github.com/mincho-js/mincho/commit/69b3b3990e3507da43ee68058a2d02ee28aef26a)]:
  - @mincho-js/transform-to-vanilla@0.1.0

## 0.0.4

### Patch Changes

- [#116](https://github.com/mincho-js/mincho/pull/116) [`9d5f878`](https://github.com/mincho-js/mincho/commit/9d5f878754e216b21fa233e215b25523c822a9a7) Thanks [@black7375](https://github.com/black7375)! - Variant features

- Updated dependencies [[`9d5f878`](https://github.com/mincho-js/mincho/commit/9d5f878754e216b21fa233e215b25523c822a9a7)]:
  - @mincho-js/transform-to-vanilla@0.0.3

## 0.0.3

### Patch Changes

- [#84](https://github.com/mincho-js/mincho/pull/84) [`747fc29`](https://github.com/mincho-js/mincho/commit/747fc29ef35ad113981bb31ac2e7617dc280d05b) Thanks [@Jeong-jj](https://github.com/Jeong-jj)! - Edit logo image raw path

## 0.0.2

### Patch Changes

- [#66](https://github.com/mincho-js/mincho/pull/66) [`3db93f7`](https://github.com/mincho-js/mincho/commit/3db93f706ee39bd4365891e5c8fd25c66609a99f) Thanks [@black7375](https://github.com/black7375)! - First released

- Updated dependencies [[`3db93f7`](https://github.com/mincho-js/mincho/commit/3db93f706ee39bd4365891e5c8fd25c66609a99f)]:
  - @mincho-js/transform-to-vanilla@0.0.2
