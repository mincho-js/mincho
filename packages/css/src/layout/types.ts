/** All numeric lengths are CSS pixels, never token multipliers. */
export type Percentage = `${number}%`;
export type Stretch = "stretch" | { mode: "stretch"; weight?: number };
export type Size = number | Percentage | "hug-contents" | Stretch;
export type Shrink = boolean | { weight?: number };
/** Full intent model for tooling; requires a precision renderer for weights/bounds. */
export type PrecisionBoundarySpace =
  number | Stretch | { size: Stretch; minSize?: number; maxSize?: number };
export type PrecisionBreakPolicy = "allow" | "never" | "force";
/** Native renderer's public subset. */
export type BoundarySpace =
  number | "stretch" | { mode: "stretch"; weight?: 1 };
export type BreakPolicy = "allow";
export type Axis = "horizontal" | "vertical";
export type Direction = "ltr" | "rtl";
export type PositionAlignment = "start" | "center" | "end";
export type Align = PositionAlignment | "baseline";
export type Justify = PositionAlignment | "between" | "around" | "evenly";
export type Overflow = "visible" | "clip" | "auto" | "scroll";

type PaddingForms = {
  axes: { horizontal?: number; vertical?: number };
  physical: { top?: number; right?: number; bottom?: number; left?: number };
  logicalAxes: { inline?: number; block?: number };
  logical: {
    inlineStart?: number;
    inlineEnd?: number;
    blockStart?: number;
    blockEnd?: number;
  };
};
type PaddingKeys = {
  [K in keyof PaddingForms]: keyof PaddingForms[K];
}[keyof PaddingForms];
export type Padding =
  | number
  | {
      [K in keyof PaddingForms]: PaddingForms[K] &
        Partial<Record<Exclude<PaddingKeys, keyof PaddingForms[K]>, never>>;
    }[keyof PaddingForms];

export interface SizeProps {
  width?: Size;
  height?: Size;
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

export interface PlacementProps {
  shrink?: Shrink;
  alignSelf?: "auto" | Align;
}

export type FlowPositionProps = {
  position?: "flow" | "relative";
  top?: never;
  right?: never;
  bottom?: never;
  left?: never;
};

export type AbsolutePositionProps = {
  position: "absolute";
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
};

export type LayoutPositionProps =
  | (FlowPositionProps & PlacementProps)
  | (AbsolutePositionProps & { shrink?: never; alignSelf?: never });

export interface BoxConfig extends SizeProps {
  padding?: Padding;
  overflow?: Overflow;
  direction?: Direction;
}

export type BoxOptions = BoxConfig & LayoutPositionProps;

export interface StackConfig {
  gap?: number;
  justify?: Justify;
  align?: Align;
  wrap?: boolean;
  lineGap?: number;
  alignLines?: Justify;
}

export type StackOptions = BoxOptions & StackConfig & { axis: Axis };
export type HStackOptions = BoxOptions & StackConfig & { axis?: never };
export type VStackOptions = BoxOptions &
  Omit<StackConfig, "align"> & {
    align?: PositionAlignment;
    axis?: never;
  };

export interface ItemRelationProps {
  gapBefore?: BoundarySpace;
  gapAfter?: BoundarySpace;
  breakBefore?: BreakPolicy;
  breakAfter?: BreakPolicy;
}

export interface ItemRelationRequirements {
  gapBefore?: PrecisionBoundarySpace;
  gapAfter?: PrecisionBoundarySpace;
  breakBefore?: PrecisionBreakPolicy;
  breakAfter?: PrecisionBreakPolicy;
}

type ItemConfig<Relations> = BoxConfig &
  (
    | (FlowPositionProps & PlacementProps & Relations)
    | (AbsolutePositionProps & {
        shrink?: never;
        alignSelf?: never;
        gapBefore?: never;
        gapAfter?: never;
        breakBefore?: never;
        breakAfter?: never;
      })
  );
export type ItemOptions = ItemConfig<ItemRelationProps>;
/** Unrendered semantic input, used by normalization and capability diagnostics. */
export type ItemRequirements = ItemConfig<ItemRelationRequirements>;

export type LayoutDiagnosticCode =
  | "E_INVALID_NUMBER"
  | "E_INVALID_BOUNDS"
  | "E_INVALID_PADDING"
  | "E_DUPLICATE_BOUNDARY_SPACE"
  | "E_DUPLICATE_BREAK"
  | "E_MIXED_SPACE_DISTRIBUTION"
  | "E_INVALID_BREAK_EDGE"
  | "E_FORCE_WITHOUT_WRAP"
  | "E_FORCE_WITH_EXPLICIT_SPACE"
  | "E_WRAP_ONLY_PROP"
  | "E_INVALID_ITEM_PARENT"
  | "E_UNSUPPORTED_DOM_CHILD"
  | "E_INVALID_LAYOUT_ROOT"
  | "E_INVALID_PLACEMENT"
  | "E_UNSUPPORTED_BASELINE"
  | "E_PERCENT_DEPENDENCY"
  | "E_MEASUREMENT_CYCLE"
  | "E_LAYOUT_CAPABILITY";

export interface LayoutDiagnostic {
  code: LayoutDiagnosticCode;
  message: string;
  itemId?: string;
  boundaryId?: string;
}

export type NormalizedSize =
  | { kind: "fixed"; value: number }
  | { kind: "percent"; ratio: number }
  | { kind: "content" }
  | { kind: "stretch"; weight: number; explicitWeight: boolean };

export type NormalizedSpace =
  | { kind: "fixed"; value: number }
  | { kind: "stretch"; weight: number; min: number; max: number };

export interface CanonicalBoundary {
  previousId: string;
  nextId: string;
  space: NormalizedSpace;
  breakPolicy: PrecisionBreakPolicy;
  declaredBy: "parent-gap" | "before" | "after";
}

export interface EdgeSpace {
  itemId: string;
  side: "before" | "after";
  space: NormalizedSpace;
}

export interface LayoutItem {
  id: string;
  /** Omit for an ordinary, browser-owned DOM item. */
  props?: ItemRequirements;
}

/** A participant accepted by native class-name patterns. */
export interface NativeLayoutItem {
  id: string;
  props?: ItemOptions;
}

/** CSS declarations shared by extraction and the DOM renderer. */
export type NativeStyle = Record<string, string | number>;
