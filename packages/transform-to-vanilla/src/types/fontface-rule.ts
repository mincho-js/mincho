import type { NonNullableString, Fallback, DataType } from "@mincho-js/csstype";
import type { Arr } from "./utils";

export type FontFaceRule = Omit<GlobalFontFaceRule, "fontFamily">;
export interface GlobalFontFaceRule
  extends Fallback<FontFaceBaseRule>,
    FontFaceMergeRule {}

type RequiredFontFaceRule = Required<FontFaceBaseRule>;
interface FontFaceBaseRule {
  /**
   * The **`font-feature-settings`** CSS descriptor allows you to define the initial settings to use for the font defined by the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   * You can further use this descriptor to control typographic font features such as ligatures, small caps, and swashes, for the font defined by `@font-face`.
   * The values for this descriptor are the same as the [`font-feature-settings property`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face), except for the global keyword values.
   *
   * **Syntax**: `normal | <feature-tag-value>#`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-feature-settings
   */
  MozFontFeatureSettings?: FontFeatureSettings | undefined;
  /**
   * The **`ascent-override`** CSS descriptor for the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule defines the ascent metric for the font.
   * The ascent metric is the height above the baseline that CSS uses to lay out line boxes in an inline formatting context.
   *
   * **Syntax**: `[ normal | <percentage [0,∞]> ]{1,2}`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/ascent-override
   */
  ascentOverride?: AscentOverride | undefined;
  /**
   * The **`descent-override`** CSS descriptor for the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule defines the descent metric for the font.
   * The descent metric is the height below the baseline that CSS uses to lay out line boxes in an inline formatting context.
   *
   * **Syntax**: `[ normal | <percentage [0,∞]> ]{1,2}`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/descent-override
   */
  descentOverride?: DescentOverride | undefined;
  /**
   * The **`font-display`** descriptor for the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule determines how a font face is displayed based on whether and when it is downloaded and ready to use.
   *
   * **Syntax**: `auto` | `block` | `swap` | `fallback` | `optional`
   *
   * **Initial value**: `auto`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-display
   */
  fontDisplay?: FontDisplay | undefined;
  /**
   * The **`font-family`** CSS descriptor sets the font family for a font specified in an [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   *
   * **Syntax**: `<family-name>`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-family
   */
  fontFamily: string;
  /**
   * The **`font-feature-settings`** CSS descriptor allows you to define the initial settings to use for the font defined by the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   * You can further use this descriptor to control typographic font features such as ligatures, small caps, and swashes, for the font defined by `@font-face`.
   * The values for this descriptor are the same as the [`font-feature-settings property`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face), except for the global keyword values.
   *
   * **Syntax**: `normal | <feature-tag-value>#`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-feature-settings
   */
  fontFeatureSettings?: FontFeatureSettings | undefined;
  /**
   * The **font-stretch** CSS descriptor allows authors to specify a normal, condensed, or expanded face for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   *
   * **Syntax**: `<'font-stretch'>{1,2} `
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-stretch
   */
  fontStretch?: FontStretch | undefined;
  /**
   * The **`font-style`** CSS descriptor allows authors to specify font styles for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   *
   * **Syntax**: `auto` | `normal` | `italic` | `oblique <angle [-90deg,90deg]>?]`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-style
   */
  fontStyle?: FontStyle | undefined;
  /**
   * The **`font-variant`** CSS [shorthand property](https://developer.mozilla.org/en-US/docs/Web/CSS/Shorthand_properties) allows you to set all the font variants for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) rule.
   *
   * @deprecated
   * The `font-variant` descriptor was removed from the specification in 2018.
   * The [`font-variant`](https://developer.mozilla.org/en-US/docs/Web/CSS/font-variant) value property is supported, but there is no descriptor equivalent.
   *
   * **Syntax**: `normal | none | [ <common-lig-values> || <discretionary-lig-values> || <historical-lig-values> || <contextual-alt-values> || stylistic( <feature-value-name> ) || historical-forms || styleset( <feature-value-name># ) || character-variant( <feature-value-name># ) || swash( <feature-value-name> ) || ornaments( <feature-value-name> ) || annotation( <feature-value-name> ) || [ small-caps | all-small-caps | petite-caps | all-petite-caps | unicase | titling-caps ] || <numeric-figure-values> || <numeric-spacing-values> || <numeric-fraction-values> || ordinal || slashed-zero || <east-asian-variant-values> || <east-asian-width-values> || ruby ]`
   *
   * **Initial value**: `normal`
   *
   * @see [https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-variant](https://web.archive.org/web/20220926063657/https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-variant)
   *
   */
  fontVariant?: FontVariant | undefined;
  /**
   * The **`font-variation-settings`** CSS descriptor allows authors to specify low-level OpenType or TrueType font variations in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   * The values for this descriptor are the same as the [`font-variation-settings`](https://developer.mozilla.org/en-US/docs/Web/CSS/font-variation-settings) property, except for the global keyword values.
   *
   * **Syntax**: `normal` | `[ <string> <number> ]#`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-variation-settings
   */
  fontVariationSettings?: FontVariationSettings | undefined;
  /**
   * The **`font-weight`** CSS descriptor allows authors to specify font weights for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   * The [`font-weight`](https://developer.mozilla.org/en-US/docs/Web/CSS/font-weight) property can separately be used to set how thick or thin characters in text should be displayed.
   *
   * **Syntax**: `auto` | `<font-weight-absolute>{1,2}`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-weight
   */
  fontWeight?: FontWeight | undefined;
  /**
   * The **`line-gap-override`** CSS descriptor for the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule defines the line-gap metric for the font.
   * The line-gap metric is the font recommended line-gap or external leading.
   *
   * **Syntax**: `[ normal | <percentage [0,∞]> ]{1,2}`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/line-gap-override
   */
  lineGapOverride?: LineGapOverride | undefined;
  /**
   * The **`size-adjust`** CSS descriptor for the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule defines a multiplier for glyph outlines and metrics associated with this font.
   * This makes it easier to harmonize the designs of various fonts when rendered at the same font size.
   *
   * **Syntax**: `<percentage [0,∞]>`
   *
   * **Initial value**: `100%`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/size-adjust
   */
  sizeAdjust?: string | undefined;
  /**
   * The **`src`** CSS descriptor for the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule specifies the resource containing font data.
   * It is required for the `@font-face rule` to be valid.
   *
   * **Syntax**: `<url> [ format( <font-format> ) ]? [ tech( <font-tech># ) ]?  | local( <family-name> )`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/src
   */
  src?: string | undefined;
  /**
   * The **`unicode-range`** CSS descriptor sets the specific range of characters to be used from a font defined using the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule and made available for use on the current page.
   * If the page doesn't use any character in this range, the font is not downloaded; if it uses at least one, the whole font is downloaded.
   *
   * **Syntax**: `<urange>`
   *
   * **Initial value**: `U+0-10FFFF`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/unicode-range
   */
  unicodeRange?: string | undefined;
}

export interface FontFaceMergeRule {
  /**
   * The **font-stretch** CSS descriptor allows authors to specify a normal, condensed, or expanded face for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   *
   * **Syntax**: `<'font-stretch'>{1,2} `
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-stretch
   */
  fontStretch_?: Arr<Exclude<RequiredFontFaceRule["fontStretch"], "normal">, 2>;

  /**
   * The **`font-style`** CSS descriptor allows authors to specify font styles for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   *
   * **Syntax**: `oblique <angle [-90deg,90deg]>?]`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-style
   */
  fontStyle_?: ["oblique", ...`${number}${Angle}`[]];

  /**
   * The **`font-weight`** CSS descriptor allows authors to specify font weights for the fonts specified in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   * The [`font-weight`](https://developer.mozilla.org/en-US/docs/Web/CSS/font-weight) property can separately be used to set how thick or thin characters in text should be displayed.
   *
   * **Syntax**: `<font-weight-absolute>{1,2}`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-weight
   */
  fontWeight_?: RequiredFontFaceRule["fontWeight"][];

  /**
   * The **`font-feature-settings`** CSS descriptor allows you to define the initial settings to use for the font defined by the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   * You can further use this descriptor to control typographic font features such as ligatures, small caps, and swashes, for the font defined by `@font-face`.
   * The values for this descriptor are the same as the [`font-feature-settings property`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face), except for the global keyword values.
   *
   * **Syntax**: `<feature-tag-value>#`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-feature-settings
   */
  fontFeatureSettings$?: FeatureTagValue;
  /**
   * The **`font-feature-settings`** CSS descriptor allows you to define the initial settings to use for the font defined by the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   * You can further use this descriptor to control typographic font features such as ligatures, small caps, and swashes, for the font defined by `@font-face`.
   * The values for this descriptor are the same as the [`font-feature-settings property`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face), except for the global keyword values.
   *
   * **Syntax**: `<feature-tag-value>#`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-feature-settings
   */
  MozFontFeatureSettings$?: FeatureTagValue;

  /**
   * The **`font-variation-settings`** CSS descriptor allows authors to specify low-level OpenType or TrueType font variations in the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule.
   * The values for this descriptor are the same as the [`font-variation-settings`](https://developer.mozilla.org/en-US/docs/Web/CSS/font-variation-settings) property, except for the global keyword values.
   *
   * **Syntax**: `[ <string> <number> ]#`
   *
   * **Initial value**: `normal`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/font-variation-settings
   */
  fontVariationSettings$?: `${string} ${number}`[];

  /**
   * The **`src`** CSS descriptor for the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule specifies the resource containing font data.
   * It is required for the `@font-face rule` to be valid.
   *
   * **Syntax**: `<url> [ format( <font-format> ) ]? [ tech( <font-tech># ) ]?  | local( <family-name> )`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/src
   */
  src$?: FontFaceSrc[];

  /**
   * The **`unicode-range`** CSS descriptor sets the specific range of characters to be used from a font defined using the [`@font-face`](https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face) at-rule and made available for use on the current page.
   * If the page doesn't use any character in this range, the font is not downloaded; if it uses at least one, the whole font is downloaded.
   *
   * **Syntax**: `<urange>`
   *
   * **Initial value**: `U+0-10FFFF`
   *
   * @see https://developer.mozilla.org/en-US/docs/Web/CSS/@font-face/unicode-range
   */
  unicodeRange$?: `U+${string}`[];
}

type FontFeatureSettings = "normal" | NonNullableString;
type AscentOverride = "normal" | NonNullableString;
type DescentOverride = "normal" | NonNullableString;
type FontStretch = DataType.FontStretchAbsolute | NonNullableString;
type FontStyle = "italic" | "normal" | "oblique" | NonNullableString;
type FontVariant =
  | DataType.EastAsianVariantValues
  | "all-petite-caps"
  | "all-small-caps"
  | "common-ligatures"
  | "contextual"
  | "diagonal-fractions"
  | "discretionary-ligatures"
  | "full-width"
  | "historical-forms"
  | "historical-ligatures"
  | "lining-nums"
  | "no-common-ligatures"
  | "no-contextual"
  | "no-discretionary-ligatures"
  | "no-historical-ligatures"
  | "none"
  | "normal"
  | "oldstyle-nums"
  | "ordinal"
  | "petite-caps"
  | "proportional-nums"
  | "proportional-width"
  | "ruby"
  | "slashed-zero"
  | "small-caps"
  | "stacked-fractions"
  | "tabular-nums"
  | "titling-caps"
  | "unicase"
  | NonNullableString;
type FontVariationSettings = "normal" | NonNullableString;
type FontWeight = DataType.FontWeightAbsolute | NonNullableString;
type LineGapOverride = "normal" | NonNullableString;

type Angle = "deg" | "grad" | "rad" | "turn";
type FeatureTagValue = (NonNullableString &
  `${string} ${number | "on" | "off"}`)[];
type FontFaceSrc =
  | `local(${string})`
  | `url(${string})`
  | `url(${string}) format(${string})`
  | `url(${string}) tech(${string})`
  | `url(${string}) format(${string}) tech(${string})`;
