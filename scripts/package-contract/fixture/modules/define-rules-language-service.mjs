import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = dirname(fileURLToPath(import.meta.url));
const expected = new Map();
const positions = new Map();
function cursor(label, names) {
  expected.set(label, names);
  return `/*completion:${label}*/`;
}

// Use the declaration files an editor loads from an installed package. Valid
// source checks inference as well as the language service's completion list.
const marked = `
import { defineRules, rules as standaloneRules } from "@mincho-js/css";
const definitions = defineRules({
  properties: {
    color: { brand: "navy", muted: "gray" },
    display: ["flex", "block"],
    paddingLeft: { small: 4, large: 16 },
    paddingRight: { small: 4, large: 16 }
  },
  shortcuts: { px: ["paddingLeft", "paddingRight"], inline: { display: "flex" } },
  conditions: { hover: { selector: "&:hover" } },
  context: { tone: "brand" }
});
const { css, rules, cx } = definitions;
css({ ${cursor("css-keys", ["color", "px", "inline", "_hover"])} });
css({ color: "${cursor("css-token", ["brand", "muted"])}brand" });
css({ px: "${cursor("css-shortcut", ["small", "large"])}small" });
css("${cursor("css-boolean-shortcut", ["inline"])}inline");
css({ _hover: { color: "${cursor("css-nested-token", ["brand", "muted"])}brand" } });
css({ color: { _hover: "${cursor("css-property-condition", ["brand", "muted"])}brand" } });
css(context => ({ color: context.${cursor("css-context", ["tone"])}tone }));
css.raw({ color: "${cursor("css-raw", ["brand", "muted"])}brand" });
css.raw(context => ({ color: context.${cursor("css-raw-context", ["tone"])}tone }));

const standalone = standaloneRules({ variants: { size: { small: { color: "red" }, large: { color: "blue" } } } });
standalone({ size: "${cursor("standalone-selection", ["small", "large"])}large" });
rules({ ${cursor("rules-keys", ["color", "px", "base", "variants", "props", "defaultVariants", "compoundVariants"])} });
rules({ base: { color: "${cursor("rules-base", ["brand", "muted"])}brand" } });
rules({ variants: { size: { large: { ${cursor("rules-variant-keys", ["color", "px", "_hover"])} } } } });
const recipe = rules({
  variants: {
    size: {
      small: { color: "${cursor("rules-variant-token", ["brand", "muted"])}brand" },
      large: context => ({ color: context.${cursor("rules-variant-context", ["tone"])}tone })
    },
    active: { true: { inline: true }, false: { display: "block" } }
  },
  props: ["width"],
  defaultVariants: { size: "${cursor("rules-default", ["small", "large"])}small" },
  compoundVariants: variants => [{
    condition: [variants.size.${cursor("rules-compound", ["small", "large"])}large],
    style: context => ({ color: context.${cursor("rules-compound-context", ["tone"])}tone })
  }]
});
recipe({ ${cursor("recipe-keys", ["size", "active"])} });
recipe({ size: "${cursor("recipe-selection", ["small", "large"])}large", active: false });
recipe.props({ ${cursor("recipe-props", ["width"])} });
recipe.classNames.variants.${cursor("recipe-classes", ["size", "active"])}size;
const variantNames: Array<"size" | "active"> = recipe.variants();
const baseOnly = rules({ base: { color: "brand" } });
const baseVariantNames: never[] = baseOnly.variants();
const inherited = rules.extends(recipe, { base: { px: "small" } });
inherited({ size: "${cursor("extends-inherited-selection", ["small", "large"])}small" });
const baseWith = rules.with(style => ({ base: style }));
const withVariantNames: never[] = baseWith({ color: "brand" }).variants();
const callbacks = rules({
  variants: { tone: { strong: context => ({ color: context.tone }) } },
  defaultVariants: { tone: "strong" },
  compoundVariants: variants => [{ condition: [variants.tone.strong], style: { px: "small" } }]
});
callbacks({ tone: "${cursor("callback-only-selection", ["strong"])}strong" });
const contextualMixin = rules.with(style => ({
  base: style,
  variants: { tone: { strong: context => ({ color: context.tone }) } },
  defaultVariants: { tone: "strong" },
  compoundVariants: variants => [{ condition: [variants.tone.strong], style: { px: "small" } }]
}));
contextualMixin({ px: "small" })({ tone: "${cursor("with-callback-selection", ["strong"])}strong" });
const restricted = rules.with((style: { px: "small" | "large" }) => ({ base: style }));
restricted({ px: "${cursor("with-restricted-input", ["small", "large"])}small" });

const raw = rules.raw({
  variants: { size: { small: { px: "${cursor("rules-raw", ["small", "large"])}small" } } }
});
standaloneRules(raw)({ size: "small" });
const multiple = rules.multiple({
  action: {
    variants: { size: {
      small: { color: "brand" },
      large: context => ({ color: context.${cursor("multiple-context", ["tone"])}tone })
    } },
    props: ["width"],
    defaultVariants: { size: "${cursor("multiple-default", ["small", "large"])}small" },
    compoundVariants: variants => [{
      condition: [variants.size.${cursor("multiple-compound", ["small", "large"])}large],
      style: { px: "large" }
    }]
  },
  card: { variants: { tone: { neutral: { color: "muted" } } }, props: ["height"] }
});
multiple.${cursor("multiple-keys", ["action", "card"])}action;
multiple.action({ size: "${cursor("multiple-selection", ["small", "large"])}small" });
multiple.card.props({ ${cursor("multiple-props", ["height"])} });
const typed: { variants?: { active: { true: { color: "brand" } } }; props?: ["width"] } = {
  variants: { active: { true: { color: "brand" } } }, props: ["width"]
};
const optional = rules.multiple({ card: { base: { px: "small" } }, typed });
optional.typed({ active: true });
optional.typed.props({ width: 12 });
rules(typed)({ active: true });
standaloneRules(rules.raw(typed))({ active: true });

const withStyle = rules.with(style => ({
  base: { color: style.${cursor("with-style", ["color", "px", "_hover"])}color },
  variants: { tone: { strong: { color: "brand" }, soft: { color: "muted" } } }
}));
const fromWith = withStyle({ color: "${cursor("with-input", ["brand", "muted"])}brand" });
fromWith({ tone: "${cursor("with-selection", ["strong", "soft"])}strong" });
standaloneRules(withStyle.raw({ color: "brand" }))({ tone: "soft" });
withStyle.multiple({ compact: { color: "brand" } }).compact({ tone: "${cursor("with-multiple-selection", ["strong", "soft"])}strong" });
const withChild = withStyle.extends(recipe, { color: "brand" });
withChild({ size: "${cursor("with-extends-parent", ["small", "large"])}small", tone: "${cursor("with-extends-own", ["strong", "soft"])}soft" });
const extended = rules.extends(recipe, {
  variants: { size: { huge: context => ({ color: context.${cursor("extends-context", ["tone"])}tone }) } },
  defaultVariants: { size: "${cursor("extends-default", ["small", "large", "huge"])}huge" },
  compoundVariants: variants => [{
    condition: [variants.size.${cursor("extends-compound", ["small", "large", "huge"])}huge],
    style: { px: "large" }
  }]
});
extended({ size: "${cursor("extends-selection", ["small", "large", "huge"])}large" });
extended.props({ width: 24 });
const child = defineRules.extends(definitions, { properties: { color: { accent: "purple" } } });
child.css({ color: "${cursor("extended-css", ["brand", "muted", "accent"])}accent" });
child.rules({ base: { color: "${cursor("extended-rules", ["brand", "muted", "accent"])}accent" } });

const classes = cx.multiple({ card: recipe(), active: recipe({ active: true }) });
classes.${cursor("cx-multiple", ["card", "active"])}card;
const selected = cx.with<"card" | "active">();
selected("${cursor("cx-with", ["card", "active"])}card");
const classMixin = cx.with((tone: "strong" | "soft") => fromWith({ tone }));
classMixin("${cursor("cx-with-callback", ["strong", "soft"])}strong");

// Completion candidates alone must not hide inference widened to any or string.
// @ts-expect-error The context type must survive variant inference.
rules({ variants: { bad: { true: context => ({ color: context.missing }) } } });
// @ts-expect-error Only declared tokens are accepted.
rules({ variants: { bad: { true: { color: "unknown" } } } });
// @ts-expect-error Runtime selections retain exact variant values.
recipe({ size: "missing" });
// @ts-expect-error Boolean variants take boolean values.
recipe({ active: "true" });
// @ts-expect-error A recipe only owns its declared runtime props.
multiple.action.props({ height: 24 });
// @ts-expect-error Each multiple recipe keeps its own variant groups.
multiple.card({ size: "small" });
// @ts-expect-error Defaults are checked against the same recipe's variants.
rules.multiple({ action: { variants: { size: { small: { color: "brand" } } }, defaultVariants: { size: "missing" } } });
// @ts-expect-error Inference survives optional, annotated option fields.
optional.typed({ active: "true" });
// @ts-expect-error A with callback retains its recipe variant values.
fromWith({ tone: "missing" });
// @ts-expect-error Parent and child variants are a closed union.
extended({ size: "missing" });
// @ts-expect-error Adding only base styles must keep parent variant values closed.
inherited({ size: "missing" });
// @ts-expect-error A callback's explicit input type is preserved.
restricted({ color: "brand" });
// @ts-expect-error Context-only variant definitions keep exact value names.
contextualMixin({ px: "small" })({ tone: "missing" });
`;

let removed = 0;
const source = marked.replace(
  /\/\*completion:([\w-]+)\*\//g,
  (marker, label, offset) => {
    positions.set(label, offset - removed);
    removed += marker.length;
    return "";
  }
);

for (const [extension, module, moduleResolution] of [
  ["mts", ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
  ["cts", ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
  ["ts", ts.ModuleKind.CommonJS, ts.ModuleResolutionKind.Node10]
]) {
  const filename = join(root, `define-rules-editor.${extension}`);
  const options = {
    strict: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module,
    moduleResolution,
    types: []
  };
  const host = {
    ...ts.sys,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getCompilationSettings: () => options,
    getScriptFileNames: () => [filename],
    getScriptVersion: () => "0",
    getScriptSnapshot(file) {
      const text = file === filename ? source : ts.sys.readFile(file);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getDefaultLibFileName: (settings) => ts.getDefaultLibFilePath(settings),
    fileExists: (file) => file === filename || ts.sys.fileExists(file)
  };
  const service = ts.createLanguageService(host);
  try {
    const diagnostics = [
      ...service.getCompilerOptionsDiagnostics(),
      ...service.getSyntacticDiagnostics(filename),
      ...service.getSemanticDiagnostics(filename)
    ];
    assert.equal(
      diagnostics.length,
      0,
      ts.formatDiagnostics(diagnostics, {
        getCanonicalFileName: (file) => file,
        getCurrentDirectory: () => root,
        getNewLine: () => "\n"
      })
    );
    for (const [label, names] of expected) {
      const result = service.getCompletionsAtPosition(
        filename,
        positions.get(label),
        {}
      );
      const candidates = new Set(result?.entries.map((entry) => entry.name));
      for (const name of names) {
        assert(candidates.has(name), `${extension} ${label}: missing ${name}`);
      }
    }
    console.log(
      `[define-rules language service] ${extension}: inference and ${expected.size} completion sites passed`
    );
  } finally {
    service.dispose();
  }
}
