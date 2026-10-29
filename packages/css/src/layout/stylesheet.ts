/**
 * The shared layout stylesheet. Elements declare their own values as CSS
 * variables; these rules choose the values that apply for the actual parent,
 * so neither the React renderer nor compiled output needs to know the parent.
 */
const prefix = "--mincho-layout-";

export const layoutVars = {
  /** Set by every Stack; inherited by its children. */
  gap: `${prefix}gap`,
  width: `${prefix}w`,
  height: `${prefix}h`,
  /** Sizes, flex factors and alignment when a dimension is a Stack's main or cross axis. */
  widthMain: `${prefix}w-main`,
  heightMain: `${prefix}h-main`,
  widthCross: `${prefix}w-cross`,
  heightCross: `${prefix}h-cross`,
  growWidth: `${prefix}grow-w`,
  growHeight: `${prefix}grow-h`,
  shrinkWidth: `${prefix}shrink-w`,
  shrinkHeight: `${prefix}shrink-h`,
  basisWidth: `${prefix}basis-w`,
  basisHeight: `${prefix}basis-h`,
  selfWidth: `${prefix}self-w`,
  selfHeight: `${prefix}self-h`,
  before: `${prefix}before`,
  after: `${prefix}after`,
  beforeAuto: `${prefix}before-auto`,
  afterAuto: `${prefix}after-auto`,
  beforeMargin: `${prefix}before-margin`,
  afterMargin: `${prefix}after-margin`
} as const;

const v = layoutVars;
/** Per-element variables; reset so that descendants never inherit them. */
const elementVars = Object.values(v).filter((name) => name !== v.gap);

const element = "[data-mincho-layout][data-mincho-layout]";
const axis = (value: string) =>
  `[data-mincho-layout-axis="${value}"][data-mincho-layout-axis]`;
const child = (value: string) =>
  `[data-mincho-layout-axis="${value}"]>${element}`;
// Elements absent from the DOM or marked `hidden` are not siblings.
const flowSibling =
  ":not([hidden],[data-mincho-layout-out],script,style,template,link)";

/**
 * Doubled attributes keep layout declarations above single-class decoration,
 * as inline styles were. Variables are reset with zero specificity so inline
 * styles and compiled classes always set them.
 */
export const layoutCss = [
  `:where([data-mincho-layout]){${elementVars.map((name) => `${name}:initial`).join(";")}}`,
  `${element}{box-sizing:border-box;margin:0;width:var(${v.width});height:var(${v.height})}`,
  `${axis("horizontal")},${axis("vertical")}{display:flex}`,
  `${axis("horizontal")}{flex-direction:row}`,
  `${axis("vertical")}{flex-direction:column}`,
  `${element}[hidden]{display:none}`,
  `${child("horizontal")}{width:var(${v.widthMain},var(${v.width}));height:var(${v.heightCross},var(${v.height}));flex:var(${v.growWidth},0) var(${v.shrinkWidth},0) var(${v.basisWidth},auto);align-self:var(${v.selfHeight},auto);margin-inline-start:var(${v.beforeAuto},var(${v.beforeMargin},0px));margin-inline-end:var(${v.afterAuto},var(${v.afterMargin},0px))}`,
  `${child("vertical")}{width:var(${v.widthCross},var(${v.width}));height:var(${v.heightMain},var(${v.height}));flex:var(${v.growHeight},0) var(${v.shrinkHeight},0) var(${v.basisHeight},auto);align-self:var(${v.selfWidth},auto);margin-block-start:var(${v.beforeAuto},var(${v.beforeMargin},0px));margin-block-end:var(${v.afterAuto},var(${v.afterMargin},0px))}`,
  // Between items the parent gap already exists, so a fixed space adds only
  // the difference; at an outer edge the whole space is the margin.
  `[data-mincho-layout="Item"]{${v.beforeMargin}:calc(var(${v.before}) - var(${v.gap}));${v.afterMargin}:calc(var(${v.after}) - var(${v.gap}))}`,
  `[data-mincho-layout="Item"]:nth-child(1 of ${flowSibling}){${v.beforeMargin}:var(${v.before})}`,
  `[data-mincho-layout="Item"]:nth-last-child(1 of ${flowSibling}){${v.afterMargin}:var(${v.after})}`
].join("\n");

const sheets = new WeakMap<Document, Element>();

/**
 * Installs the sheet in the host's document at commit, without a style/layout
 * read. A matching style/link marker lets applications own the sheet instead.
 * Server rendering needs `@mincho-js/css/layout.css` before hydration.
 */
export function ensureLayoutStylesheet(document: Document) {
  const installed = sheets.get(document);
  if (installed?.isConnected && installed.ownerDocument === document) return;
  const existing = document.querySelector(
    "style[data-mincho-layout-sheet],link[data-mincho-layout-sheet]"
  );
  if (existing) {
    sheets.set(document, existing);
    return;
  }
  const sheet = document.createElement("style");
  sheet.dataset.minchoLayoutSheet = "";
  sheet.textContent = layoutCss;
  document.head.append(sheet);
  sheets.set(document, sheet);
}
