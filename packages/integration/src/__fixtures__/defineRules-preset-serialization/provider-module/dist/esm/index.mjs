var stylesheets$1 = {};
var injectStyles$1 = (_ref) => {
  var {
    fileScope,
    css: css2
  } = _ref;
  var fileScopeId = fileScope.packageName ? [fileScope.packageName, fileScope.filePath].join("/") : fileScope.filePath;
  var stylesheet = stylesheets$1[fileScopeId];
  if (!stylesheet) {
    var styleEl = document.createElement("style");
    if (fileScope.packageName) {
      styleEl.setAttribute("data-package", fileScope.packageName);
    }
    styleEl.setAttribute("data-file", fileScope.filePath);
    styleEl.setAttribute("type", "text/css");
    stylesheet = stylesheets$1[fileScopeId] = styleEl;
    document.head.appendChild(styleEl);
  }
  stylesheet.innerHTML = css2;
};
function getVarName$2(variable) {
  var matches = variable.match(/^var\((.*)\)$/);
  if (matches) {
    return matches[1];
  }
  return variable;
}
function getDefaultExportFromCjs$1(x) {
  return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var cssesc_1$1;
var hasRequiredCssesc$1;
function requireCssesc$1() {
  if (hasRequiredCssesc$1) return cssesc_1$1;
  hasRequiredCssesc$1 = 1;
  var object = {};
  var hasOwnProperty = object.hasOwnProperty;
  var merge = function merge2(options, defaults) {
    if (!options) {
      return defaults;
    }
    var result = {};
    for (var key in defaults) {
      result[key] = hasOwnProperty.call(options, key) ? options[key] : defaults[key];
    }
    return result;
  };
  var regexAnySingleEscape = /[ -,\.\/:-@\[-\^`\{-~]/;
  var regexSingleEscape = /[ -,\.\/:-@\[\]\^`\{-~]/;
  var regexExcessiveSpaces = /(^|\\+)?(\\[A-F0-9]{1,6})\x20(?![a-fA-F0-9\x20])/g;
  var cssesc2 = function cssesc3(string, options) {
    options = merge(options, cssesc3.options);
    if (options.quotes != "single" && options.quotes != "double") {
      options.quotes = "single";
    }
    var quote = options.quotes == "double" ? '"' : "'";
    var isIdentifier = options.isIdentifier;
    var firstChar = string.charAt(0);
    var output = "";
    var counter = 0;
    var length = string.length;
    while (counter < length) {
      var character = string.charAt(counter++);
      var codePoint = character.charCodeAt();
      var value = void 0;
      if (codePoint < 32 || codePoint > 126) {
        if (codePoint >= 55296 && codePoint <= 56319 && counter < length) {
          var extra = string.charCodeAt(counter++);
          if ((extra & 64512) == 56320) {
            codePoint = ((codePoint & 1023) << 10) + (extra & 1023) + 65536;
          } else {
            counter--;
          }
        }
        value = "\\" + codePoint.toString(16).toUpperCase() + " ";
      } else {
        if (options.escapeEverything) {
          if (regexAnySingleEscape.test(character)) {
            value = "\\" + character;
          } else {
            value = "\\" + codePoint.toString(16).toUpperCase() + " ";
          }
        } else if (/[\t\n\f\r\x0B]/.test(character)) {
          value = "\\" + codePoint.toString(16).toUpperCase() + " ";
        } else if (character == "\\" || !isIdentifier && (character == '"' && quote == character || character == "'" && quote == character) || isIdentifier && regexSingleEscape.test(character)) {
          value = "\\" + character;
        } else {
          value = character;
        }
      }
      output += value;
    }
    if (isIdentifier) {
      if (/^-[-\d]/.test(output)) {
        output = "\\-" + output.slice(1);
      } else if (/\d/.test(firstChar)) {
        output = "\\3" + firstChar + " " + output.slice(1);
      }
    }
    output = output.replace(regexExcessiveSpaces, function($0, $1, $2) {
      if ($1 && $1.length % 2) {
        return $0;
      }
      return ($1 || "") + $2;
    });
    if (!isIdentifier && options.wrap) {
      return quote + output + quote;
    }
    return output;
  };
  cssesc2.options = {
    "escapeEverything": false,
    "isIdentifier": false,
    "quotes": "single",
    "wrap": false
  };
  cssesc2.version = "3.0.0";
  cssesc_1$1 = cssesc2;
  return cssesc_1$1;
}
var cssescExports$1 = requireCssesc$1();
const cssesc$1 = /* @__PURE__ */ getDefaultExportFromCjs$1(cssescExports$1);
let AhoCorasick$1 = class AhoCorasick {
  constructor(keywords) {
    const { failure, gotoFn, output } = this._buildTables(keywords);
    this.gotoFn = gotoFn;
    this.output = output;
    this.failure = failure;
  }
  _buildTables(keywords) {
    const gotoFn = {
      0: {}
    };
    const output = {};
    let state = 0;
    for (const word of keywords) {
      let curr = 0;
      for (const l of word) {
        if (gotoFn[curr] && l in gotoFn[curr]) {
          curr = gotoFn[curr][l];
        } else {
          state++;
          gotoFn[curr][l] = state;
          gotoFn[state] = {};
          curr = state;
          output[state] = [];
        }
      }
      output[curr].push(word);
    }
    const failure = {};
    const xs = [];
    for (const l in gotoFn[0]) {
      const state2 = gotoFn[0][l];
      failure[state2] = 0;
      xs.push(state2);
    }
    while (xs.length > 0) {
      const r2 = xs.shift();
      if (r2 !== void 0) {
        for (const l in gotoFn[r2]) {
          const s = gotoFn[r2][l];
          xs.push(s);
          let state2 = failure[r2];
          while (state2 > 0 && !(l in gotoFn[state2])) {
            state2 = failure[state2];
          }
          if (l in gotoFn[state2]) {
            const fs = gotoFn[state2][l];
            failure[s] = fs;
            output[s] = [...output[s], ...output[fs]];
          } else {
            failure[s] = 0;
          }
        }
      }
    }
    return {
      gotoFn,
      output,
      failure
    };
  }
  search(str) {
    let state = 0;
    const results = [];
    for (let i = 0; i < str.length; i++) {
      const l = str[i];
      while (state > 0 && !(l in this.gotoFn[state])) {
        state = this.failure[state];
      }
      if (!(l in this.gotoFn[state])) {
        continue;
      }
      state = this.gotoFn[state][l];
      if (this.output[state].length > 0) {
        const foundStrs = this.output[state];
        results.push([i, foundStrs]);
      }
    }
    return results;
  }
};
var mockAdapter$1 = {
  appendCss: () => {
  },
  registerClassName: () => {
  },
  onEndFileScope: () => {
  },
  registerComposition: () => {
  },
  markCompositionUsed: () => {
  },
  getIdentOption: () => process.env.NODE_ENV === "production" ? "short" : "debug"
};
var adapterStack$1 = [mockAdapter$1];
var currentAdapter$1 = () => {
  if (adapterStack$1.length < 1) {
    throw new Error("No adapter configured");
  }
  return adapterStack$1[adapterStack$1.length - 1];
};
var hasConfiguredAdapter$1 = false;
var setAdapterIfNotSet$1 = (newAdapter) => {
  if (!hasConfiguredAdapter$1) {
    setAdapter$1(newAdapter);
  }
};
var setAdapter$1 = (newAdapter) => {
  if (!newAdapter) {
    throw new Error('No adapter provided when calling "setAdapter"');
  }
  hasConfiguredAdapter$1 = true;
  adapterStack$1.push(newAdapter);
};
var appendCss$1 = function appendCss() {
  return currentAdapter$1().appendCss(...arguments);
};
var registerClassName = function registerClassName2() {
  return currentAdapter$1().registerClassName(...arguments);
};
var registerComposition = function registerComposition2() {
  return currentAdapter$1().registerComposition(...arguments);
};
var markCompositionUsed$1 = function markCompositionUsed() {
  return currentAdapter$1().markCompositionUsed(...arguments);
};
var getIdentOption$1 = function getIdentOption() {
  var adapter = currentAdapter$1();
  if (!("getIdentOption" in adapter)) {
    return process.env.NODE_ENV === "production" ? "short" : "debug";
  }
  return adapter.getIdentOption(...arguments);
};
function _taggedTemplateLiteral$1(strings, raw) {
  if (!raw) {
    raw = strings.slice(0);
  }
  return Object.freeze(Object.defineProperties(strings, {
    raw: {
      value: Object.freeze(raw)
    }
  }));
}
var SelectorType$1;
(function(SelectorType2) {
  SelectorType2["Attribute"] = "attribute";
  SelectorType2["Pseudo"] = "pseudo";
  SelectorType2["PseudoElement"] = "pseudo-element";
  SelectorType2["Tag"] = "tag";
  SelectorType2["Universal"] = "universal";
  SelectorType2["Adjacent"] = "adjacent";
  SelectorType2["Child"] = "child";
  SelectorType2["Descendant"] = "descendant";
  SelectorType2["Parent"] = "parent";
  SelectorType2["Sibling"] = "sibling";
  SelectorType2["ColumnCombinator"] = "column-combinator";
})(SelectorType$1 || (SelectorType$1 = {}));
var AttributeAction$1;
(function(AttributeAction2) {
  AttributeAction2["Any"] = "any";
  AttributeAction2["Element"] = "element";
  AttributeAction2["End"] = "end";
  AttributeAction2["Equals"] = "equals";
  AttributeAction2["Exists"] = "exists";
  AttributeAction2["Hyphen"] = "hyphen";
  AttributeAction2["Not"] = "not";
  AttributeAction2["Start"] = "start";
})(AttributeAction$1 || (AttributeAction$1 = {}));
const reName$1 = /^[^\\#]?(?:\\(?:[\da-f]{1,6}\s?|.)|[\w\-\u00b0-\uFFFF])+/;
const reEscape$1 = /\\([\da-f]{1,6}\s?|(\s)|.)/gi;
const actionTypes$1 = /* @__PURE__ */ new Map([
  [126, AttributeAction$1.Element],
  [94, AttributeAction$1.Start],
  [36, AttributeAction$1.End],
  [42, AttributeAction$1.Any],
  [33, AttributeAction$1.Not],
  [124, AttributeAction$1.Hyphen]
]);
const unpackPseudos$1 = /* @__PURE__ */ new Set([
  "has",
  "not",
  "matches",
  "is",
  "where",
  "host",
  "host-context"
]);
function isTraversal$1(selector) {
  switch (selector.type) {
    case SelectorType$1.Adjacent:
    case SelectorType$1.Child:
    case SelectorType$1.Descendant:
    case SelectorType$1.Parent:
    case SelectorType$1.Sibling:
    case SelectorType$1.ColumnCombinator:
      return true;
    default:
      return false;
  }
}
const stripQuotesFromPseudos$1 = /* @__PURE__ */ new Set(["contains", "icontains"]);
function funescape$1(_, escaped, escapedWhitespace) {
  const high = parseInt(escaped, 16) - 65536;
  return high !== high || escapedWhitespace ? escaped : high < 0 ? (
    // BMP codepoint
    String.fromCharCode(high + 65536)
  ) : (
    // Supplemental Plane codepoint (surrogate pair)
    String.fromCharCode(high >> 10 | 55296, high & 1023 | 56320)
  );
}
function unescapeCSS$1(str) {
  return str.replace(reEscape$1, funescape$1);
}
function isQuote$1(c) {
  return c === 39 || c === 34;
}
function isWhitespace$1(c) {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}
function parse$1(selector) {
  const subselects = [];
  const endIndex = parseSelector$1(subselects, `${selector}`, 0);
  if (endIndex < selector.length) {
    throw new Error(`Unmatched selector: ${selector.slice(endIndex)}`);
  }
  return subselects;
}
function parseSelector$1(subselects, selector, selectorIndex) {
  let tokens = [];
  function getName(offset) {
    const match = selector.slice(selectorIndex + offset).match(reName$1);
    if (!match) {
      throw new Error(`Expected name, found ${selector.slice(selectorIndex)}`);
    }
    const [name] = match;
    selectorIndex += offset + name.length;
    return unescapeCSS$1(name);
  }
  function stripWhitespace(offset) {
    selectorIndex += offset;
    while (selectorIndex < selector.length && isWhitespace$1(selector.charCodeAt(selectorIndex))) {
      selectorIndex++;
    }
  }
  function readValueWithParenthesis() {
    selectorIndex += 1;
    const start = selectorIndex;
    let counter = 1;
    for (; counter > 0 && selectorIndex < selector.length; selectorIndex++) {
      if (selector.charCodeAt(selectorIndex) === 40 && !isEscaped(selectorIndex)) {
        counter++;
      } else if (selector.charCodeAt(selectorIndex) === 41 && !isEscaped(selectorIndex)) {
        counter--;
      }
    }
    if (counter) {
      throw new Error("Parenthesis not matched");
    }
    return unescapeCSS$1(selector.slice(start, selectorIndex - 1));
  }
  function isEscaped(pos) {
    let slashCount = 0;
    while (selector.charCodeAt(--pos) === 92)
      slashCount++;
    return (slashCount & 1) === 1;
  }
  function ensureNotTraversal() {
    if (tokens.length > 0 && isTraversal$1(tokens[tokens.length - 1])) {
      throw new Error("Did not expect successive traversals.");
    }
  }
  function addTraversal(type) {
    if (tokens.length > 0 && tokens[tokens.length - 1].type === SelectorType$1.Descendant) {
      tokens[tokens.length - 1].type = type;
      return;
    }
    ensureNotTraversal();
    tokens.push({ type });
  }
  function addSpecialAttribute(name, action) {
    tokens.push({
      type: SelectorType$1.Attribute,
      name,
      action,
      value: getName(1),
      namespace: null,
      ignoreCase: "quirks"
    });
  }
  function finalizeSubselector() {
    if (tokens.length && tokens[tokens.length - 1].type === SelectorType$1.Descendant) {
      tokens.pop();
    }
    if (tokens.length === 0) {
      throw new Error("Empty sub-selector");
    }
    subselects.push(tokens);
  }
  stripWhitespace(0);
  if (selector.length === selectorIndex) {
    return selectorIndex;
  }
  loop: while (selectorIndex < selector.length) {
    const firstChar = selector.charCodeAt(selectorIndex);
    switch (firstChar) {
      // Whitespace
      case 32:
      case 9:
      case 10:
      case 12:
      case 13: {
        if (tokens.length === 0 || tokens[0].type !== SelectorType$1.Descendant) {
          ensureNotTraversal();
          tokens.push({ type: SelectorType$1.Descendant });
        }
        stripWhitespace(1);
        break;
      }
      // Traversals
      case 62: {
        addTraversal(SelectorType$1.Child);
        stripWhitespace(1);
        break;
      }
      case 60: {
        addTraversal(SelectorType$1.Parent);
        stripWhitespace(1);
        break;
      }
      case 126: {
        addTraversal(SelectorType$1.Sibling);
        stripWhitespace(1);
        break;
      }
      case 43: {
        addTraversal(SelectorType$1.Adjacent);
        stripWhitespace(1);
        break;
      }
      // Special attribute selectors: .class, #id
      case 46: {
        addSpecialAttribute("class", AttributeAction$1.Element);
        break;
      }
      case 35: {
        addSpecialAttribute("id", AttributeAction$1.Equals);
        break;
      }
      case 91: {
        stripWhitespace(1);
        let name;
        let namespace = null;
        if (selector.charCodeAt(selectorIndex) === 124) {
          name = getName(1);
        } else if (selector.startsWith("*|", selectorIndex)) {
          namespace = "*";
          name = getName(2);
        } else {
          name = getName(0);
          if (selector.charCodeAt(selectorIndex) === 124 && selector.charCodeAt(selectorIndex + 1) !== 61) {
            namespace = name;
            name = getName(1);
          }
        }
        stripWhitespace(0);
        let action = AttributeAction$1.Exists;
        const possibleAction = actionTypes$1.get(selector.charCodeAt(selectorIndex));
        if (possibleAction) {
          action = possibleAction;
          if (selector.charCodeAt(selectorIndex + 1) !== 61) {
            throw new Error("Expected `=`");
          }
          stripWhitespace(2);
        } else if (selector.charCodeAt(selectorIndex) === 61) {
          action = AttributeAction$1.Equals;
          stripWhitespace(1);
        }
        let value = "";
        let ignoreCase = null;
        if (action !== "exists") {
          if (isQuote$1(selector.charCodeAt(selectorIndex))) {
            const quote = selector.charCodeAt(selectorIndex);
            let sectionEnd = selectorIndex + 1;
            while (sectionEnd < selector.length && (selector.charCodeAt(sectionEnd) !== quote || isEscaped(sectionEnd))) {
              sectionEnd += 1;
            }
            if (selector.charCodeAt(sectionEnd) !== quote) {
              throw new Error("Attribute value didn't end");
            }
            value = unescapeCSS$1(selector.slice(selectorIndex + 1, sectionEnd));
            selectorIndex = sectionEnd + 1;
          } else {
            const valueStart = selectorIndex;
            while (selectorIndex < selector.length && (!isWhitespace$1(selector.charCodeAt(selectorIndex)) && selector.charCodeAt(selectorIndex) !== 93 || isEscaped(selectorIndex))) {
              selectorIndex += 1;
            }
            value = unescapeCSS$1(selector.slice(valueStart, selectorIndex));
          }
          stripWhitespace(0);
          const forceIgnore = selector.charCodeAt(selectorIndex) | 32;
          if (forceIgnore === 115) {
            ignoreCase = false;
            stripWhitespace(1);
          } else if (forceIgnore === 105) {
            ignoreCase = true;
            stripWhitespace(1);
          }
        }
        if (selector.charCodeAt(selectorIndex) !== 93) {
          throw new Error("Attribute selector didn't terminate");
        }
        selectorIndex += 1;
        const attributeSelector = {
          type: SelectorType$1.Attribute,
          name,
          action,
          value,
          namespace,
          ignoreCase
        };
        tokens.push(attributeSelector);
        break;
      }
      case 58: {
        if (selector.charCodeAt(selectorIndex + 1) === 58) {
          tokens.push({
            type: SelectorType$1.PseudoElement,
            name: getName(2).toLowerCase(),
            data: selector.charCodeAt(selectorIndex) === 40 ? readValueWithParenthesis() : null
          });
          continue;
        }
        const name = getName(1).toLowerCase();
        let data = null;
        if (selector.charCodeAt(selectorIndex) === 40) {
          if (unpackPseudos$1.has(name)) {
            if (isQuote$1(selector.charCodeAt(selectorIndex + 1))) {
              throw new Error(`Pseudo-selector ${name} cannot be quoted`);
            }
            data = [];
            selectorIndex = parseSelector$1(data, selector, selectorIndex + 1);
            if (selector.charCodeAt(selectorIndex) !== 41) {
              throw new Error(`Missing closing parenthesis in :${name} (${selector})`);
            }
            selectorIndex += 1;
          } else {
            data = readValueWithParenthesis();
            if (stripQuotesFromPseudos$1.has(name)) {
              const quot = data.charCodeAt(0);
              if (quot === data.charCodeAt(data.length - 1) && isQuote$1(quot)) {
                data = data.slice(1, -1);
              }
            }
            data = unescapeCSS$1(data);
          }
        }
        tokens.push({ type: SelectorType$1.Pseudo, name, data });
        break;
      }
      case 44: {
        finalizeSubselector();
        tokens = [];
        stripWhitespace(1);
        break;
      }
      default: {
        if (selector.startsWith("/*", selectorIndex)) {
          const endIndex = selector.indexOf("*/", selectorIndex + 2);
          if (endIndex < 0) {
            throw new Error("Comment was not terminated");
          }
          selectorIndex = endIndex + 2;
          if (tokens.length === 0) {
            stripWhitespace(0);
          }
          break;
        }
        let namespace = null;
        let name;
        if (firstChar === 42) {
          selectorIndex += 1;
          name = "*";
        } else if (firstChar === 124) {
          name = "";
          if (selector.charCodeAt(selectorIndex + 1) === 124) {
            addTraversal(SelectorType$1.ColumnCombinator);
            stripWhitespace(2);
            break;
          }
        } else if (reName$1.test(selector.slice(selectorIndex))) {
          name = getName(0);
        } else {
          break loop;
        }
        if (selector.charCodeAt(selectorIndex) === 124 && selector.charCodeAt(selectorIndex + 1) !== 124) {
          namespace = name;
          if (selector.charCodeAt(selectorIndex + 1) === 42) {
            name = "*";
            selectorIndex += 2;
          } else {
            name = getName(1);
          }
        }
        tokens.push(name === "*" ? { type: SelectorType$1.Universal, namespace } : { type: SelectorType$1.Tag, name, namespace });
      }
    }
  }
  finalizeSubselector();
  return selectorIndex;
}
function ownKeys$3(object, enumerableOnly) {
  var keys = Object.keys(object);
  if (Object.getOwnPropertySymbols) {
    var symbols = Object.getOwnPropertySymbols(object);
    enumerableOnly && (symbols = symbols.filter(function(sym) {
      return Object.getOwnPropertyDescriptor(object, sym).enumerable;
    })), keys.push.apply(keys, symbols);
  }
  return keys;
}
function _objectSpread$1(target) {
  for (var i = 1; i < arguments.length; i++) {
    var source = null != arguments[i] ? arguments[i] : {};
    i % 2 ? ownKeys$3(Object(source), true).forEach(function(key) {
      _defineProperty$3(target, key, source[key]);
    }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) : ownKeys$3(Object(source)).forEach(function(key) {
      Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
    });
  }
  return target;
}
function _defineProperty$3(obj, key, value) {
  key = _toPropertyKey$1(key);
  if (key in obj) {
    Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
  } else {
    obj[key] = value;
  }
  return obj;
}
function _toPropertyKey$1(arg) {
  var key = _toPrimitive$1(arg, "string");
  return typeof key === "symbol" ? key : String(key);
}
function _toPrimitive$1(input, hint) {
  if (typeof input !== "object" || input === null) return input;
  var prim = input[Symbol.toPrimitive];
  if (prim !== void 0) {
    var res = prim.call(input, hint);
    if (typeof res !== "object") return res;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (hint === "string" ? String : Number)(input);
}
const dedent$1 = createDedent$1({});
function createDedent$1(options) {
  dedent2.withOptions = (newOptions) => createDedent$1(_objectSpread$1(_objectSpread$1({}, options), newOptions));
  return dedent2;
  function dedent2(strings, ...values) {
    const raw = typeof strings === "string" ? [strings] : strings.raw;
    const {
      alignValues = false,
      escapeSpecialCharacters = Array.isArray(strings),
      trimWhitespace = true
    } = options;
    let result = "";
    for (let i = 0; i < raw.length; i++) {
      let next = raw[i];
      if (escapeSpecialCharacters) {
        next = next.replace(/\\\n[ \t]*/g, "").replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\{/g, "{");
      }
      result += next;
      if (i < values.length) {
        const value = alignValues ? alignValue$1(values[i], result) : values[i];
        result += value;
      }
    }
    const lines = result.split("\n");
    let mindent = null;
    for (const l of lines) {
      const m = l.match(/^(\s+)\S+/);
      if (m) {
        const indent = m[1].length;
        if (!mindent) {
          mindent = indent;
        } else {
          mindent = Math.min(mindent, indent);
        }
      }
    }
    if (mindent !== null) {
      const m = mindent;
      result = lines.map((l) => l[0] === " " || l[0] === "	" ? l.slice(m) : l).join("\n");
    }
    if (trimWhitespace) {
      result = result.trim();
    }
    if (escapeSpecialCharacters) {
      result = result.replace(/\\n/g, "\n");
    }
    return result;
  }
}
function alignValue$1(value, precedingText) {
  if (typeof value !== "string" || !value.includes("\n")) {
    return value;
  }
  const currentLine = precedingText.slice(precedingText.lastIndexOf("\n") + 1);
  const indentMatch = currentLine.match(/^(\s+)/);
  if (indentMatch) {
    const indent = indentMatch[1];
    return value.replace(/\n/g, `
${indent}`);
  }
  return value;
}
var __assign$1 = function() {
  __assign$1 = Object.assign || function __assign2(t) {
    for (var s, i = 1, n = arguments.length; i < n; i++) {
      s = arguments[i];
      for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
    }
    return t;
  };
  return __assign$1.apply(this, arguments);
};
function __rest$1(s, e) {
  var t = {};
  for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
    t[p] = s[p];
  if (s != null && typeof Object.getOwnPropertySymbols === "function")
    for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
      if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
        t[p[i]] = s[p[i]];
    }
  return t;
}
function __values$1(o) {
  var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
  if (m) return m.call(o);
  if (o && typeof o.length === "number") return {
    next: function() {
      if (o && i >= o.length) o = void 0;
      return { value: o && o[i++], done: !o };
    }
  };
  throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}
function __read$1(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r2, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r2 = i.next()).done) ar.push(r2.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r2 && !r2.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
}
var weirdNewlines$1 = /(\u000D|\u000C|\u000D\u000A)/g;
var nullOrSurrogates$1 = /[\u0000\uD800-\uDFFF]/g;
var commentRegex$1 = /(\/\*)[\s\S]*?(\*\/)/g;
var lexicalAnalysis$1 = function lexicalAnalysis(str, index) {
  if (index === void 0) {
    index = 0;
  }
  str = str.replace(weirdNewlines$1, "\n").replace(nullOrSurrogates$1, "�");
  str = str.replace(commentRegex$1, "");
  var tokens = [];
  for (; index < str.length; index += 1) {
    var code = str.charCodeAt(index);
    if (code === 9 || code === 32 || code === 10) {
      var code_1 = str.charCodeAt(++index);
      while (code_1 === 9 || code_1 === 32 || code_1 === 10) {
        code_1 = str.charCodeAt(++index);
      }
      index -= 1;
      tokens.push({
        type: "<whitespace-token>"
      });
    } else if (code === 34) {
      var result = consumeString$1(str, index);
      if (result === null) {
        return null;
      }
      var _a2 = __read$1(result, 2), lastIndex = _a2[0], value = _a2[1];
      tokens.push({
        type: "<string-token>",
        value
      });
      index = lastIndex;
    } else if (code === 35) {
      if (index + 1 < str.length) {
        var nextCode = str.charCodeAt(index + 1);
        if (nextCode === 95 || nextCode >= 65 && nextCode <= 90 || nextCode >= 97 && nextCode <= 122 || nextCode >= 128 || nextCode >= 48 && nextCode <= 57 || nextCode === 92 && index + 2 < str.length && str.charCodeAt(index + 2) !== 10) {
          var flag = wouldStartIdentifier$1(str, index + 1) ? "id" : "unrestricted";
          var result = consumeIdentUnsafe$1(str, index + 1);
          if (result !== null) {
            var _b2 = __read$1(result, 2), lastIndex = _b2[0], value = _b2[1];
            tokens.push({
              type: "<hash-token>",
              value: value.toLowerCase(),
              flag
            });
            index = lastIndex;
            continue;
          }
        }
      }
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    } else if (code === 39) {
      var result = consumeString$1(str, index);
      if (result === null) {
        return null;
      }
      var _c = __read$1(result, 2), lastIndex = _c[0], value = _c[1];
      tokens.push({
        type: "<string-token>",
        value
      });
      index = lastIndex;
    } else if (code === 40) {
      tokens.push({
        type: "<(-token>"
      });
    } else if (code === 41) {
      tokens.push({
        type: "<)-token>"
      });
    } else if (code === 43) {
      var plusNumeric = consumeNumeric$1(str, index);
      if (plusNumeric === null) {
        tokens.push({
          type: "<delim-token>",
          value: code
        });
      } else {
        var _d = __read$1(plusNumeric, 2), lastIndex = _d[0], tokenTuple = _d[1];
        if (tokenTuple[0] === "<dimension-token>") {
          tokens.push({
            type: "<dimension-token>",
            value: tokenTuple[1],
            unit: tokenTuple[2].toLowerCase(),
            flag: "number"
          });
        } else if (tokenTuple[0] === "<number-token>") {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: tokenTuple[2]
          });
        } else {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: "number"
          });
        }
        index = lastIndex;
      }
    } else if (code === 44) {
      tokens.push({
        type: "<comma-token>"
      });
    } else if (code === 45) {
      var minusNumeric = consumeNumeric$1(str, index);
      if (minusNumeric !== null) {
        var _e = __read$1(minusNumeric, 2), lastIndex = _e[0], tokenTuple = _e[1];
        if (tokenTuple[0] === "<dimension-token>") {
          tokens.push({
            type: "<dimension-token>",
            value: tokenTuple[1],
            unit: tokenTuple[2].toLowerCase(),
            flag: "number"
          });
        } else if (tokenTuple[0] === "<number-token>") {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: tokenTuple[2]
          });
        } else {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: "number"
          });
        }
        index = lastIndex;
        continue;
      }
      if (index + 2 < str.length) {
        var nextCode = str.charCodeAt(index + 1);
        var nextNextCode = str.charCodeAt(index + 2);
        if (nextCode === 45 && nextNextCode === 62) {
          tokens.push({
            type: "<CDC-token>"
          });
          index += 2;
          continue;
        }
      }
      var result = consumeIdentLike$1(str, index);
      if (result !== null) {
        var _f = __read$1(result, 3), lastIndex = _f[0], value = _f[1], type = _f[2];
        tokens.push({
          type,
          value
        });
        index = lastIndex;
        continue;
      }
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    } else if (code === 46) {
      var minusNumeric = consumeNumeric$1(str, index);
      if (minusNumeric === null) {
        tokens.push({
          type: "<delim-token>",
          value: code
        });
      } else {
        var _g = __read$1(minusNumeric, 2), lastIndex = _g[0], tokenTuple = _g[1];
        if (tokenTuple[0] === "<dimension-token>") {
          tokens.push({
            type: "<dimension-token>",
            value: tokenTuple[1],
            unit: tokenTuple[2].toLowerCase(),
            flag: "number"
          });
        } else if (tokenTuple[0] === "<number-token>") {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: tokenTuple[2]
          });
        } else {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: "number"
          });
        }
        index = lastIndex;
        continue;
      }
    } else if (code === 58) {
      tokens.push({
        type: "<colon-token>"
      });
    } else if (code === 59) {
      tokens.push({
        type: "<semicolon-token>"
      });
    } else if (code === 60) {
      if (index + 3 < str.length) {
        var nextCode = str.charCodeAt(index + 1);
        var nextNextCode = str.charCodeAt(index + 2);
        var nextNextNextCode = str.charCodeAt(index + 3);
        if (nextCode === 33 && nextNextCode === 45 && nextNextNextCode === 45) {
          tokens.push({
            type: "<CDO-token>"
          });
          index += 3;
          continue;
        }
      }
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    } else if (code === 64) {
      var result = consumeIdent$1(str, index + 1);
      if (result !== null) {
        var _h = __read$1(result, 2), lastIndex = _h[0], value = _h[1];
        tokens.push({
          type: "<at-keyword-token>",
          value: value.toLowerCase()
        });
        index = lastIndex;
        continue;
      }
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    } else if (code === 91) {
      tokens.push({
        type: "<[-token>"
      });
    } else if (code === 92) {
      var result = consumeEscape$1(str, index);
      if (result === null) {
        return null;
      }
      var _j = __read$1(result, 2), lastIndex = _j[0], value = _j[1];
      str = str.slice(0, index) + value + str.slice(lastIndex + 1);
      index -= 1;
    } else if (code === 93) {
      tokens.push({
        type: "<]-token>"
      });
    } else if (code === 123) {
      tokens.push({
        type: "<{-token>"
      });
    } else if (code === 125) {
      tokens.push({
        type: "<}-token>"
      });
    } else if (code >= 48 && code <= 57) {
      var result = consumeNumeric$1(str, index);
      var _k = __read$1(result, 2), lastIndex = _k[0], tokenTuple = _k[1];
      if (tokenTuple[0] === "<dimension-token>") {
        tokens.push({
          type: "<dimension-token>",
          value: tokenTuple[1],
          unit: tokenTuple[2].toLowerCase(),
          flag: "number"
        });
      } else if (tokenTuple[0] === "<number-token>") {
        tokens.push({
          type: tokenTuple[0],
          value: tokenTuple[1],
          flag: tokenTuple[2]
        });
      } else {
        tokens.push({
          type: tokenTuple[0],
          value: tokenTuple[1],
          flag: "number"
        });
      }
      index = lastIndex;
    } else if (code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 128) {
      var result = consumeIdentLike$1(str, index);
      if (result === null) {
        return null;
      }
      var _l = __read$1(result, 3), lastIndex = _l[0], value = _l[1], type = _l[2];
      tokens.push({
        type,
        value
      });
      index = lastIndex;
    } else {
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    }
  }
  tokens.push({
    type: "<EOF-token>"
  });
  return tokens;
};
var consumeString$1 = function consumeString(str, index) {
  if (str.length <= index + 1) return null;
  var firstCode = str.charCodeAt(index);
  var charCodes = [];
  for (var i = index + 1; i < str.length; i += 1) {
    var code = str.charCodeAt(i);
    if (code === firstCode) {
      return [i, String.fromCharCode.apply(null, charCodes)];
    } else if (code === 92) {
      var result = consumeEscape$1(str, i);
      if (result === null) return null;
      var _a2 = __read$1(result, 2), lastIndex = _a2[0], charCode = _a2[1];
      charCodes.push(charCode);
      i = lastIndex;
    } else if (code === 10) {
      return null;
    } else {
      charCodes.push(code);
    }
  }
  return null;
};
var wouldStartIdentifier$1 = function wouldStartIdentifier(str, index) {
  if (str.length <= index) return false;
  var code = str.charCodeAt(index);
  if (code === 45) {
    if (str.length <= index + 1) return false;
    var nextCode = str.charCodeAt(index + 1);
    if (nextCode === 45 || nextCode === 95 || nextCode >= 65 && nextCode <= 90 || nextCode >= 97 && nextCode <= 122 || nextCode >= 128) {
      return true;
    } else if (nextCode === 92) {
      if (str.length <= index + 2) return false;
      var nextNextCode = str.charCodeAt(index + 2);
      return nextNextCode !== 10;
    } else {
      return false;
    }
  } else if (code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 128) {
    return true;
  } else if (code === 92) {
    if (str.length <= index + 1) return false;
    var nextCode = str.charCodeAt(index + 1);
    return nextCode !== 10;
  } else {
    return false;
  }
};
var consumeEscape$1 = function consumeEscape(str, index) {
  if (str.length <= index + 1) return null;
  if (str.charCodeAt(index) !== 92) return null;
  var code = str.charCodeAt(index + 1);
  if (code === 10) {
    return null;
  } else if (code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102) {
    var hexCharCodes = [code];
    var min = Math.min(index + 7, str.length);
    var i = index + 2;
    for (; i < min; i += 1) {
      var code_2 = str.charCodeAt(i);
      if (code_2 >= 48 && code_2 <= 57 || code_2 >= 65 && code_2 <= 70 || code_2 >= 97 && code_2 <= 102) {
        hexCharCodes.push(code_2);
      } else {
        break;
      }
    }
    if (i < str.length) {
      var code_3 = str.charCodeAt(i);
      if (code_3 === 9 || code_3 === 32 || code_3 === 10) {
        i += 1;
      }
    }
    return [i - 1, parseInt(String.fromCharCode.apply(null, hexCharCodes), 16)];
  } else {
    return [index + 1, code];
  }
};
var consumeNumeric$1 = function consumeNumeric(str, index) {
  var numberResult = consumeNumber$1(str, index);
  if (numberResult === null) return null;
  var _a2 = __read$1(numberResult, 3), numberEndIndex = _a2[0], numberValue = _a2[1], numberFlag = _a2[2];
  var identResult = consumeIdent$1(str, numberEndIndex + 1);
  if (identResult !== null) {
    var _b2 = __read$1(identResult, 2), identEndIndex = _b2[0], identValue = _b2[1];
    return [identEndIndex, ["<dimension-token>", numberValue, identValue]];
  }
  if (numberEndIndex + 1 < str.length && str.charCodeAt(numberEndIndex + 1) === 37) {
    return [numberEndIndex + 1, ["<percentage-token>", numberValue]];
  }
  return [numberEndIndex, ["<number-token>", numberValue, numberFlag]];
};
var consumeNumber$1 = function consumeNumber(str, index) {
  if (str.length <= index) return null;
  var flag = "integer";
  var numberChars = [];
  var firstCode = str.charCodeAt(index);
  if (firstCode === 43 || firstCode === 45) {
    index += 1;
    if (firstCode === 45) numberChars.push(45);
  }
  while (index < str.length) {
    var code = str.charCodeAt(index);
    if (code >= 48 && code <= 57) {
      numberChars.push(code);
      index += 1;
    } else {
      break;
    }
  }
  if (index + 1 < str.length) {
    var nextCode = str.charCodeAt(index);
    var nextNextCode = str.charCodeAt(index + 1);
    if (nextCode === 46 && nextNextCode >= 48 && nextNextCode <= 57) {
      numberChars.push(nextCode, nextNextCode);
      flag = "number";
      index += 2;
      while (index < str.length) {
        var code = str.charCodeAt(index);
        if (code >= 48 && code <= 57) {
          numberChars.push(code);
          index += 1;
        } else {
          break;
        }
      }
    }
  }
  if (index + 1 < str.length) {
    var nextCode = str.charCodeAt(index);
    var nextNextCode = str.charCodeAt(index + 1);
    var nextNextNextCode = str.charCodeAt(index + 2);
    if (nextCode === 69 || nextCode === 101) {
      var nextNextIsDigit = nextNextCode >= 48 && nextNextCode <= 57;
      if (nextNextIsDigit || (nextNextCode === 43 || nextNextCode === 45) && nextNextNextCode >= 48 && nextNextNextCode <= 57) {
        flag = "number";
        if (nextNextIsDigit) {
          numberChars.push(69, nextNextCode);
          index += 2;
        } else if (nextNextCode === 45) {
          numberChars.push(69, 45, nextNextNextCode);
          index += 3;
        } else {
          numberChars.push(69, nextNextNextCode);
          index += 3;
        }
        while (index < str.length) {
          var code = str.charCodeAt(index);
          if (code >= 48 && code <= 57) {
            numberChars.push(code);
            index += 1;
          } else {
            break;
          }
        }
      }
    }
  }
  var numberString = String.fromCharCode.apply(null, numberChars);
  var value = flag === "number" ? parseFloat(numberString) : parseInt(numberString);
  if (value === -0) value = 0;
  return Number.isNaN(value) ? null : [index - 1, value, flag];
};
var consumeIdentUnsafe$1 = function consumeIdentUnsafe(str, index) {
  if (str.length <= index) {
    return null;
  }
  var identChars = [];
  for (var code = str.charCodeAt(index); index < str.length; code = str.charCodeAt(++index)) {
    if (code === 45 || code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 128 || code >= 48 && code <= 57) {
      identChars.push(code);
      continue;
    } else {
      var result = consumeEscape$1(str, index);
      if (result !== null) {
        var _a2 = __read$1(result, 2), lastIndex = _a2[0], code_4 = _a2[1];
        identChars.push(code_4);
        index = lastIndex;
        continue;
      }
    }
    break;
  }
  return index === 0 ? null : [index - 1, String.fromCharCode.apply(null, identChars)];
};
var consumeIdent$1 = function consumeIdent(str, index) {
  if (str.length <= index || !wouldStartIdentifier$1(str, index)) {
    return null;
  }
  var identChars = [];
  for (var code = str.charCodeAt(index); index < str.length; code = str.charCodeAt(++index)) {
    if (code === 45 || code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 128 || code >= 48 && code <= 57) {
      identChars.push(code);
      continue;
    } else {
      var result = consumeEscape$1(str, index);
      if (result !== null) {
        var _a2 = __read$1(result, 2), lastIndex = _a2[0], code_5 = _a2[1];
        identChars.push(code_5);
        index = lastIndex;
        continue;
      }
    }
    break;
  }
  return [index - 1, String.fromCharCode.apply(null, identChars)];
};
var consumeUrl$1 = function consumeUrl(str, index) {
  var code = str.charCodeAt(index);
  while (code === 9 || code === 32 || code === 10) {
    code = str.charCodeAt(++index);
  }
  var urlChars = [];
  var hasFinishedWord = false;
  while (index < str.length) {
    if (code === 41) {
      return [index, String.fromCharCode.apply(null, urlChars)];
    } else if (code === 34 || code === 39 || code === 40) {
      return null;
    } else if (code === 9 || code === 32 || code === 10) {
      if (!hasFinishedWord && urlChars.length !== 0) hasFinishedWord = true;
    } else if (code === 92) {
      var result = consumeEscape$1(str, index);
      if (result === null || hasFinishedWord) return null;
      var _a2 = __read$1(result, 2), lastIndex = _a2[0], value = _a2[1];
      urlChars.push(value);
      index = lastIndex;
    } else {
      if (hasFinishedWord) return null;
      urlChars.push(code);
    }
    code = str.charCodeAt(++index);
  }
  return null;
};
var consumeIdentLike$1 = function consumeIdentLike(str, index) {
  var result = consumeIdent$1(str, index);
  if (result === null) return null;
  var _a2 = __read$1(result, 2), lastIndex = _a2[0], value = _a2[1];
  if (value.toLowerCase() === "url") {
    if (str.length > lastIndex + 1) {
      var nextCode = str.charCodeAt(lastIndex + 1);
      if (nextCode === 40) {
        for (var offset = 2; lastIndex + offset < str.length; offset += 1) {
          var nextNextCode = str.charCodeAt(lastIndex + offset);
          if (nextNextCode === 34 || nextNextCode === 39) {
            return [lastIndex + 1, value.toLowerCase(), "<function-token>"];
          } else if (nextNextCode !== 9 && nextNextCode !== 32 && nextNextCode !== 10) {
            var result_1 = consumeUrl$1(str, lastIndex + offset);
            if (result_1 === null) return null;
            var _b2 = __read$1(result_1, 2), lastUrlIndex = _b2[0], value_1 = _b2[1];
            return [lastUrlIndex, value_1, "<url-token>"];
          }
        }
        return [lastIndex + 1, value.toLowerCase(), "<function-token>"];
      }
    }
  } else if (str.length > lastIndex + 1) {
    var nextCode = str.charCodeAt(lastIndex + 1);
    if (nextCode === 40) {
      return [lastIndex + 1, value.toLowerCase(), "<function-token>"];
    }
  }
  return [lastIndex, value.toLowerCase(), "<ident-token>"];
};
var simplifyAST$1 = function simplifyAST(ast) {
  for (var i = ast.length - 1; i >= 0; i--) {
    ast[i] = simplifyMediaQuery$1(ast[i]);
  }
  return ast;
};
var simplifyMediaQuery$1 = function simplifyMediaQuery(mediaQuery) {
  if (mediaQuery.mediaCondition === null) return mediaQuery;
  var mediaCondition = simplifyMediaCondition$1(mediaQuery.mediaCondition);
  if (mediaCondition.operator === null && mediaCondition.children.length === 1 && "children" in mediaCondition.children[0]) {
    mediaCondition = mediaCondition.children[0];
  }
  return {
    mediaPrefix: mediaQuery.mediaPrefix,
    mediaType: mediaQuery.mediaType,
    mediaCondition
  };
};
var simplifyMediaCondition$1 = function simplifyMediaCondition(mediaCondition) {
  for (var i = mediaCondition.children.length - 1; i >= 0; i--) {
    var unsimplifiedChild = mediaCondition.children[i];
    if (!("context" in unsimplifiedChild)) {
      var child = simplifyMediaCondition(unsimplifiedChild);
      if (child.operator === null && child.children.length === 1) {
        mediaCondition.children[i] = child.children[0];
      } else if (child.operator === mediaCondition.operator && (child.operator === "and" || child.operator === "or")) {
        var spliceArgs = [i, 1];
        for (var i_1 = 0; i_1 < child.children.length; i_1++) {
          spliceArgs.push(child.children[i_1]);
        }
        mediaCondition.children.splice.apply(mediaCondition.children, spliceArgs);
      }
    }
  }
  return mediaCondition;
};
var createError$1 = function createError(message, err) {
  if (err instanceof Error) {
    return new Error("".concat(err.message.trim(), "\n").concat(message.trim()));
  } else {
    return new Error(message.trim());
  }
};
var toAST$1 = function toAST(str) {
  return simplifyAST$1(toUnflattenedAST$1(str));
};
var toUnflattenedAST$1 = function toUnflattenedAST(str) {
  var tokenList = lexicalAnalysis$1(str.trim());
  if (tokenList === null) {
    throw createError$1("Failed tokenizing");
  }
  var startIndex = 0;
  var endIndex = tokenList.length - 1;
  if (tokenList[0].type === "<at-keyword-token>" && tokenList[0].value === "media") {
    if (tokenList[1].type !== "<whitespace-token>") {
      throw createError$1("Expected whitespace after media");
    }
    startIndex = 2;
    for (var i = 2; i < tokenList.length - 1; i++) {
      var token = tokenList[i];
      if (token.type === "<{-token>") {
        endIndex = i;
        break;
      } else if (token.type === "<semicolon-token>") {
        throw createError$1("Expected '{' in media query but found ';'");
      }
    }
  }
  tokenList = tokenList.slice(startIndex, endIndex);
  return syntacticAnalysis$1(tokenList);
};
var removeWhitespace$1 = function removeWhitespace(tokenList) {
  var newTokenList = [];
  var before = false;
  for (var i = 0; i < tokenList.length; i++) {
    if (tokenList[i].type === "<whitespace-token>") {
      before = true;
      if (newTokenList.length > 0) {
        newTokenList[newTokenList.length - 1].wsAfter = true;
      }
    } else {
      newTokenList.push(__assign$1(__assign$1({}, tokenList[i]), {
        wsBefore: before,
        wsAfter: false
      }));
      before = false;
    }
  }
  return newTokenList;
};
var syntacticAnalysis$1 = function syntacticAnalysis(tokenList) {
  var e_1, _a2;
  var mediaQueryList = [[]];
  for (var i = 0; i < tokenList.length; i++) {
    var token = tokenList[i];
    if (token.type === "<comma-token>") {
      mediaQueryList.push([]);
    } else {
      mediaQueryList[mediaQueryList.length - 1].push(token);
    }
  }
  var mediaQueries = mediaQueryList.map(removeWhitespace$1);
  if (mediaQueries.length === 1 && mediaQueries[0].length === 0) {
    return [{
      mediaCondition: null,
      mediaPrefix: null,
      mediaType: "all"
    }];
  } else {
    var mediaQueryTokens = mediaQueries.map(function(mediaQueryTokens2) {
      if (mediaQueryTokens2.length === 0) {
        return null;
      } else {
        return tokenizeMediaQuery$1(mediaQueryTokens2);
      }
    });
    var nonNullMediaQueryTokens = [];
    try {
      for (var mediaQueryTokens_1 = __values$1(mediaQueryTokens), mediaQueryTokens_1_1 = mediaQueryTokens_1.next(); !mediaQueryTokens_1_1.done; mediaQueryTokens_1_1 = mediaQueryTokens_1.next()) {
        var mediaQueryToken = mediaQueryTokens_1_1.value;
        if (mediaQueryToken !== null) {
          nonNullMediaQueryTokens.push(mediaQueryToken);
        }
      }
    } catch (e_1_1) {
      e_1 = {
        error: e_1_1
      };
    } finally {
      try {
        if (mediaQueryTokens_1_1 && !mediaQueryTokens_1_1.done && (_a2 = mediaQueryTokens_1["return"])) _a2.call(mediaQueryTokens_1);
      } finally {
        if (e_1) throw e_1.error;
      }
    }
    if (nonNullMediaQueryTokens.length === 0) {
      throw createError$1("No valid media queries");
    }
    return nonNullMediaQueryTokens;
  }
};
var tokenizeMediaQuery$1 = function tokenizeMediaQuery(tokens) {
  var firstToken = tokens[0];
  if (firstToken.type === "<(-token>") {
    try {
      return {
        mediaPrefix: null,
        mediaType: "all",
        mediaCondition: tokenizeMediaCondition$1(tokens, true)
      };
    } catch (err) {
      throw createError$1("Expected media condition after '('", err);
    }
  } else if (firstToken.type === "<ident-token>") {
    var mediaPrefix = null;
    var mediaType = void 0;
    var value = firstToken.value;
    if (value === "only" || value === "not") {
      mediaPrefix = value;
    }
    var firstIndex = mediaPrefix === null ? 0 : 1;
    if (tokens.length <= firstIndex) {
      throw createError$1("Expected extra token in media query");
    }
    var firstNonUnaryToken = tokens[firstIndex];
    if (firstNonUnaryToken.type === "<ident-token>") {
      var value_1 = firstNonUnaryToken.value;
      if (value_1 === "all") {
        mediaType = "all";
      } else if (value_1 === "print" || value_1 === "screen") {
        mediaType = value_1;
      } else if (value_1 === "tty" || value_1 === "tv" || value_1 === "projection" || value_1 === "handheld" || value_1 === "braille" || value_1 === "embossed" || value_1 === "aural" || value_1 === "speech") {
        mediaPrefix = mediaPrefix === "not" ? null : "not";
        mediaType = "all";
      } else {
        throw createError$1("Unknown ident '".concat(value_1, "' in media query"));
      }
    } else if (mediaPrefix === "not" && firstNonUnaryToken.type === "<(-token>") {
      var tokensWithParens = [{
        type: "<(-token>",
        wsBefore: false,
        wsAfter: false
      }];
      tokensWithParens.push.apply(tokensWithParens, tokens);
      tokensWithParens.push({
        type: "<)-token>",
        wsBefore: false,
        wsAfter: false
      });
      try {
        return {
          mediaPrefix: null,
          mediaType: "all",
          mediaCondition: tokenizeMediaCondition$1(tokensWithParens, true)
        };
      } catch (err) {
        throw createError$1("Expected media condition after '('", err);
      }
    } else {
      throw createError$1("Invalid media query");
    }
    if (firstIndex + 1 === tokens.length) {
      return {
        mediaPrefix,
        mediaType,
        mediaCondition: null
      };
    } else if (firstIndex + 4 < tokens.length) {
      var secondNonUnaryToken = tokens[firstIndex + 1];
      if (secondNonUnaryToken.type === "<ident-token>" && secondNonUnaryToken.value === "and") {
        try {
          return {
            mediaPrefix,
            mediaType,
            mediaCondition: tokenizeMediaCondition$1(tokens.slice(firstIndex + 2), false)
          };
        } catch (err) {
          throw createError$1("Expected media condition after 'and'", err);
        }
      } else {
        throw createError$1("Expected 'and' after media prefix");
      }
    } else {
      throw createError$1("Expected media condition after media prefix");
    }
  } else {
    throw createError$1("Expected media condition or media prefix");
  }
};
var tokenizeMediaCondition$1 = function tokenizeMediaCondition(tokens, mayContainOr, previousOperator) {
  if (previousOperator === void 0) {
    previousOperator = null;
  }
  if (tokens.length < 3 || tokens[0].type !== "<(-token>" || tokens[tokens.length - 1].type !== "<)-token>") {
    throw new Error("Invalid media condition");
  }
  var endIndexOfFirstFeature = tokens.length - 1;
  var maxDepth = 0;
  var count = 0;
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (token.type === "<(-token>") {
      count += 1;
      maxDepth = Math.max(maxDepth, count);
    } else if (token.type === "<)-token>") {
      count -= 1;
    }
    if (count === 0) {
      endIndexOfFirstFeature = i;
      break;
    }
  }
  if (count !== 0) {
    throw new Error("Mismatched parens\nInvalid media condition");
  }
  var child;
  var featureTokens = tokens.slice(0, endIndexOfFirstFeature + 1);
  if (maxDepth === 1) {
    child = tokenizeMediaFeature$1(featureTokens);
  } else {
    if (featureTokens[1].type === "<ident-token>" && featureTokens[1].value === "not") {
      child = tokenizeMediaCondition(featureTokens.slice(2, -1), true, "not");
    } else {
      child = tokenizeMediaCondition(featureTokens.slice(1, -1), true);
    }
  }
  if (endIndexOfFirstFeature === tokens.length - 1) {
    return {
      operator: previousOperator,
      children: [child]
    };
  } else {
    var nextToken = tokens[endIndexOfFirstFeature + 1];
    if (nextToken.type !== "<ident-token>") {
      throw new Error("Invalid operator\nInvalid media condition");
    } else if (previousOperator !== null && previousOperator !== nextToken.value) {
      throw new Error("'".concat(nextToken.value, "' and '").concat(previousOperator, "' must not be at same level\nInvalid media condition"));
    } else if (nextToken.value === "or" && !mayContainOr) {
      throw new Error("Cannot use 'or' at top level of a media query\nInvalid media condition");
    } else if (nextToken.value !== "and" && nextToken.value !== "or") {
      throw new Error("Invalid operator: '".concat(nextToken.value, "'\nInvalid media condition"));
    }
    var siblings = tokenizeMediaCondition(tokens.slice(endIndexOfFirstFeature + 2), mayContainOr, nextToken.value);
    return {
      operator: nextToken.value,
      children: [child].concat(siblings.children)
    };
  }
};
var tokenizeMediaFeature$1 = function tokenizeMediaFeature(rawTokens) {
  if (rawTokens.length < 3 || rawTokens[0].type !== "<(-token>" || rawTokens[rawTokens.length - 1].type !== "<)-token>") {
    throw new Error("Invalid media feature");
  }
  var tokens = [rawTokens[0]];
  for (var i = 1; i < rawTokens.length; i++) {
    if (i < rawTokens.length - 2) {
      var a = rawTokens[i];
      var b = rawTokens[i + 1];
      var c = rawTokens[i + 2];
      if (a.type === "<number-token>" && a.value > 0 && b.type === "<delim-token>" && b.value === 47 && c.type === "<number-token>" && c.value > 0) {
        tokens.push({
          type: "<ratio-token>",
          numerator: a.value,
          denominator: c.value,
          wsBefore: a.wsBefore,
          wsAfter: c.wsAfter
        });
        i += 2;
        continue;
      }
    }
    tokens.push(rawTokens[i]);
  }
  var nextToken = tokens[1];
  if (nextToken.type === "<ident-token>" && tokens.length === 3) {
    return {
      context: "boolean",
      feature: nextToken.value
    };
  } else if (tokens.length === 5 && tokens[1].type === "<ident-token>" && tokens[2].type === "<colon-token>") {
    var valueToken = tokens[3];
    if (valueToken.type === "<number-token>" || valueToken.type === "<dimension-token>" || valueToken.type === "<ratio-token>" || valueToken.type === "<ident-token>") {
      var feature = tokens[1].value;
      var prefix = null;
      var slice = feature.slice(0, 4);
      if (slice === "min-") {
        prefix = "min";
        feature = feature.slice(4);
      } else if (slice === "max-") {
        prefix = "max";
        feature = feature.slice(4);
      }
      valueToken.wsBefore;
      valueToken.wsAfter;
      var value = __rest$1(valueToken, ["wsBefore", "wsAfter"]);
      return {
        context: "value",
        prefix,
        feature,
        value
      };
    }
  } else if (tokens.length >= 5) {
    try {
      var range = tokenizeRange$1(tokens);
      return {
        context: "range",
        feature: range.featureName,
        range
      };
    } catch (err) {
      throw createError$1("Invalid media feature", err);
    }
  }
  throw new Error("Invalid media feature");
};
var tokenizeRange$1 = function tokenizeRange(tokens) {
  var _a2, _b2, _c, _d;
  if (tokens.length < 5 || tokens[0].type !== "<(-token>" || tokens[tokens.length - 1].type !== "<)-token>") {
    throw new Error("Invalid range");
  }
  var range = {
    leftToken: null,
    leftOp: null,
    featureName: "",
    rightOp: null,
    rightToken: null
  };
  var hasLeft = tokens[1].type === "<number-token>" || tokens[1].type === "<dimension-token>" || tokens[1].type === "<ratio-token>" || tokens[1].type === "<ident-token>" && tokens[1].value === "infinite";
  if (tokens[2].type === "<delim-token>") {
    if (tokens[2].value === 60) {
      if (tokens[3].type === "<delim-token>" && tokens[3].value === 61 && !tokens[3].wsBefore) {
        range[hasLeft ? "leftOp" : "rightOp"] = "<=";
      } else {
        range[hasLeft ? "leftOp" : "rightOp"] = "<";
      }
    } else if (tokens[2].value === 62) {
      if (tokens[3].type === "<delim-token>" && tokens[3].value === 61 && !tokens[3].wsBefore) {
        range[hasLeft ? "leftOp" : "rightOp"] = ">=";
      } else {
        range[hasLeft ? "leftOp" : "rightOp"] = ">";
      }
    } else if (tokens[2].value === 61) {
      range[hasLeft ? "leftOp" : "rightOp"] = "=";
    } else {
      throw new Error("Invalid range");
    }
    if (hasLeft) {
      range.leftToken = tokens[1];
    } else if (tokens[1].type === "<ident-token>") {
      range.featureName = tokens[1].value;
    } else {
      throw new Error("Invalid range");
    }
    var tokenIndexAfterFirstOp = 2 + ((_b2 = (_a2 = range[hasLeft ? "leftOp" : "rightOp"]) === null || _a2 === void 0 ? void 0 : _a2.length) !== null && _b2 !== void 0 ? _b2 : 0);
    var tokenAfterFirstOp = tokens[tokenIndexAfterFirstOp];
    if (hasLeft) {
      if (tokenAfterFirstOp.type === "<ident-token>") {
        range.featureName = tokenAfterFirstOp.value;
        if (tokens.length >= 7) {
          var secondOpToken = tokens[tokenIndexAfterFirstOp + 1];
          var followingToken = tokens[tokenIndexAfterFirstOp + 2];
          if (secondOpToken.type === "<delim-token>") {
            var charCode = secondOpToken.value;
            if (charCode === 60) {
              if (followingToken.type === "<delim-token>" && followingToken.value === 61 && !followingToken.wsBefore) {
                range.rightOp = "<=";
              } else {
                range.rightOp = "<";
              }
            } else if (charCode === 62) {
              if (followingToken.type === "<delim-token>" && followingToken.value === 61 && !followingToken.wsBefore) {
                range.rightOp = ">=";
              } else {
                range.rightOp = ">";
              }
            } else {
              throw new Error("Invalid range");
            }
            var tokenAfterSecondOp = tokens[tokenIndexAfterFirstOp + 1 + ((_d = (_c = range.rightOp) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0)];
            range.rightToken = tokenAfterSecondOp;
          } else {
            throw new Error("Invalid range");
          }
        } else if (tokenIndexAfterFirstOp + 2 !== tokens.length) {
          throw new Error("Invalid range");
        }
      } else {
        throw new Error("Invalid range");
      }
    } else {
      range.rightToken = tokenAfterFirstOp;
    }
    var validRange = null;
    var lt = range.leftToken, leftOp = range.leftOp, featureName = range.featureName, rightOp = range.rightOp, rt = range.rightToken;
    var leftToken = null;
    if (lt !== null) {
      if (lt.type === "<ident-token>") {
        var type = lt.type, value = lt.value;
        if (value === "infinite") {
          leftToken = {
            type,
            value
          };
        }
      } else if (lt.type === "<number-token>" || lt.type === "<dimension-token>" || lt.type === "<ratio-token>") {
        lt.wsBefore;
        lt.wsAfter;
        var ltNoWS = __rest$1(lt, ["wsBefore", "wsAfter"]);
        leftToken = ltNoWS;
      }
    }
    var rightToken = null;
    if (rt !== null) {
      if (rt.type === "<ident-token>") {
        var type = rt.type, value = rt.value;
        if (value === "infinite") {
          rightToken = {
            type,
            value
          };
        }
      } else if (rt.type === "<number-token>" || rt.type === "<dimension-token>" || rt.type === "<ratio-token>") {
        rt.wsBefore;
        rt.wsAfter;
        var rtNoWS = __rest$1(rt, ["wsBefore", "wsAfter"]);
        rightToken = rtNoWS;
      }
    }
    if (leftToken !== null && rightToken !== null) {
      if ((leftOp === "<" || leftOp === "<=") && (rightOp === "<" || rightOp === "<=")) {
        validRange = {
          leftToken,
          leftOp,
          featureName,
          rightOp,
          rightToken
        };
      } else if ((leftOp === ">" || leftOp === ">=") && (rightOp === ">" || rightOp === ">=")) {
        validRange = {
          leftToken,
          leftOp,
          featureName,
          rightOp,
          rightToken
        };
      } else {
        throw new Error("Invalid range");
      }
    } else if (leftToken === null && leftOp === null && rightOp !== null && rightToken !== null) {
      validRange = {
        leftToken,
        leftOp,
        featureName,
        rightOp,
        rightToken
      };
    } else if (leftToken !== null && leftOp !== null && rightOp === null && rightToken === null) {
      validRange = {
        leftToken,
        leftOp,
        featureName,
        rightOp,
        rightToken
      };
    }
    return validRange;
  } else {
    throw new Error("Invalid range");
  }
};
function toPrimitive$1(t, r2) {
  if ("object" != typeof t || !t) return t;
  var e = t[Symbol.toPrimitive];
  if (void 0 !== e) {
    var i = e.call(t, r2);
    if ("object" != typeof i) return i;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return ("string" === r2 ? String : Number)(t);
}
function toPropertyKey$1(t) {
  var i = toPrimitive$1(t, "string");
  return "symbol" == typeof i ? i : String(i);
}
function _defineProperty$2(obj, key, value) {
  key = toPropertyKey$1(key);
  if (key in obj) {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  } else {
    obj[key] = value;
  }
  return obj;
}
function ownKeys$2(e, r2) {
  var t = Object.keys(e);
  if (Object.getOwnPropertySymbols) {
    var o = Object.getOwnPropertySymbols(e);
    r2 && (o = o.filter(function(r3) {
      return Object.getOwnPropertyDescriptor(e, r3).enumerable;
    })), t.push.apply(t, o);
  }
  return t;
}
function _objectSpread2$1(e) {
  for (var r2 = 1; r2 < arguments.length; r2++) {
    var t = null != arguments[r2] ? arguments[r2] : {};
    r2 % 2 ? ownKeys$2(Object(t), true).forEach(function(r3) {
      _defineProperty$2(e, r3, t[r3]);
    }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys$2(Object(t)).forEach(function(r3) {
      Object.defineProperty(e, r3, Object.getOwnPropertyDescriptor(t, r3));
    });
  }
  return e;
}
function _objectWithoutPropertiesLoose$1(source, excluded) {
  if (source == null) return {};
  var target = {};
  var sourceKeys = Object.keys(source);
  var key, i;
  for (i = 0; i < sourceKeys.length; i++) {
    key = sourceKeys[i];
    if (excluded.indexOf(key) >= 0) continue;
    target[key] = source[key];
  }
  return target;
}
function _objectWithoutProperties$1(source, excluded) {
  if (source == null) return {};
  var target = _objectWithoutPropertiesLoose$1(source, excluded);
  var key, i;
  if (Object.getOwnPropertySymbols) {
    var sourceSymbolKeys = Object.getOwnPropertySymbols(source);
    for (i = 0; i < sourceSymbolKeys.length; i++) {
      key = sourceSymbolKeys[i];
      if (excluded.indexOf(key) >= 0) continue;
      if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
      target[key] = source[key];
    }
  }
  return target;
}
function forEach$1(obj, fn) {
  for (var _key in obj) {
    fn(obj[_key], _key);
  }
}
function omit$1(obj, omitKeys) {
  var result = {};
  for (var _key2 in obj) {
    if (omitKeys.indexOf(_key2) === -1) {
      result[_key2] = obj[_key2];
    }
  }
  return result;
}
function mapKeys$1(obj, fn) {
  var result = {};
  for (var _key3 in obj) {
    result[fn(obj[_key3], _key3)] = obj[_key3];
  }
  return result;
}
function composeStylesIntoSet(set) {
  for (var _len = arguments.length, classNames = new Array(_len > 1 ? _len - 1 : 0), _key5 = 1; _key5 < _len; _key5++) {
    classNames[_key5 - 1] = arguments[_key5];
  }
  for (var className of classNames) {
    if (className.length === 0) {
      continue;
    }
    if (typeof className === "string") {
      if (className.includes(" ")) {
        composeStylesIntoSet(set, ...className.trim().split(" "));
      } else {
        set.add(className);
      }
    } else if (Array.isArray(className)) {
      composeStylesIntoSet(set, ...className);
    }
  }
}
function dudupeAndJoinClassList(classNames) {
  var set = /* @__PURE__ */ new Set();
  composeStylesIntoSet(set, ...classNames);
  return Array.from(set).join(" ");
}
var _templateObject$1$2;
function escapeRegex$1(string) {
  return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}
var validateSelector$1 = (selector, targetClassName) => {
  var replaceTarget = () => {
    var targetRegex = new RegExp(".".concat(escapeRegex$1(cssesc$1(targetClassName, {
      isIdentifier: true
    }))), "g");
    return selector.replace(targetRegex, "&");
  };
  var selectorParts;
  try {
    selectorParts = parse$1(selector);
  } catch (err) {
    throw new Error("Invalid selector: ".concat(replaceTarget()));
  }
  selectorParts.forEach((tokens) => {
    try {
      for (var i = tokens.length - 1; i >= -1; i--) {
        if (!tokens[i]) {
          throw new Error();
        }
        var token = tokens[i];
        if (token.type === "child" || token.type === "parent" || token.type === "sibling" || token.type === "adjacent" || token.type === "descendant") {
          throw new Error();
        }
        if (token.type === "attribute" && token.name === "class" && token.value === targetClassName) {
          return;
        }
      }
    } catch (err) {
      throw new Error(dedent$1(_templateObject$1$2 || (_templateObject$1$2 = _taggedTemplateLiteral$1(["\n        Invalid selector: ", "\n    \n        Style selectors must target the '&' character (along with any modifiers), e.g. ", " or ", ".\n        \n        This is to ensure that each style block only affects the styling of a single class.\n        \n        If your selector is targeting another class, you should move it to the style definition for that class, e.g. given we have styles for 'parent' and 'child' elements, instead of adding a selector of ", ") to 'parent', you should add ", " to 'child').\n        \n        If your selector is targeting something global, use the 'globalStyle' function instead, e.g. if you wanted to write ", ", you should instead write 'globalStyle(", ", { ... })'\n      "])), replaceTarget(), "`${parent} &`", "`${parent} &:hover`", "`& ${child}`", "`${parent} &`", "`& h1`", "`${parent} h1`"));
    }
  });
};
let ConditionalRuleset$1 = class ConditionalRuleset {
  /**
   * Stores information about where conditions must be in relation to other conditions
   *
   * e.g. mobile -> tablet, desktop
   */
  constructor() {
    this.ruleset = /* @__PURE__ */ new Map();
    this.precedenceLookup = /* @__PURE__ */ new Map();
  }
  findOrCreateCondition(conditionQuery) {
    var targetCondition = this.ruleset.get(conditionQuery);
    if (!targetCondition) {
      targetCondition = {
        query: conditionQuery,
        rules: [],
        children: new ConditionalRuleset()
      };
      this.ruleset.set(conditionQuery, targetCondition);
    }
    return targetCondition;
  }
  getConditionalRulesetByPath(conditionPath) {
    var currRuleset = this;
    for (var query of conditionPath) {
      var condition = currRuleset.findOrCreateCondition(query);
      currRuleset = condition.children;
    }
    return currRuleset;
  }
  addRule(rule, conditionQuery, conditionPath) {
    var ruleset = this.getConditionalRulesetByPath(conditionPath);
    var targetCondition = ruleset.findOrCreateCondition(conditionQuery);
    if (!targetCondition) {
      throw new Error("Failed to add conditional rule");
    }
    targetCondition.rules.push(rule);
  }
  addConditionPrecedence(conditionPath, conditionOrder) {
    var ruleset = this.getConditionalRulesetByPath(conditionPath);
    for (var i = 0; i < conditionOrder.length; i++) {
      var _ruleset$precedenceLo;
      var query = conditionOrder[i];
      var conditionPrecedence = (_ruleset$precedenceLo = ruleset.precedenceLookup.get(query)) !== null && _ruleset$precedenceLo !== void 0 ? _ruleset$precedenceLo : /* @__PURE__ */ new Set();
      for (var lowerPrecedenceCondition of conditionOrder.slice(i + 1)) {
        conditionPrecedence.add(lowerPrecedenceCondition);
      }
      ruleset.precedenceLookup.set(query, conditionPrecedence);
    }
  }
  isCompatible(incomingRuleset) {
    for (var [condition, orderPrecedence] of this.precedenceLookup.entries()) {
      for (var lowerPrecedenceCondition of orderPrecedence) {
        var _incomingRuleset$prec;
        if ((_incomingRuleset$prec = incomingRuleset.precedenceLookup.get(lowerPrecedenceCondition)) !== null && _incomingRuleset$prec !== void 0 && _incomingRuleset$prec.has(condition)) {
          return false;
        }
      }
    }
    for (var {
      query,
      children
    } of incomingRuleset.ruleset.values()) {
      var matchingCondition = this.ruleset.get(query);
      if (matchingCondition && !matchingCondition.children.isCompatible(children)) {
        return false;
      }
    }
    return true;
  }
  merge(incomingRuleset) {
    for (var {
      query,
      rules,
      children
    } of incomingRuleset.ruleset.values()) {
      var matchingCondition = this.ruleset.get(query);
      if (matchingCondition) {
        matchingCondition.rules.push(...rules);
        matchingCondition.children.merge(children);
      } else {
        this.ruleset.set(query, {
          query,
          rules,
          children
        });
      }
    }
    for (var [condition, incomingOrderPrecedence] of incomingRuleset.precedenceLookup.entries()) {
      var _this$precedenceLooku;
      var orderPrecedence = (_this$precedenceLooku = this.precedenceLookup.get(condition)) !== null && _this$precedenceLooku !== void 0 ? _this$precedenceLooku : /* @__PURE__ */ new Set();
      this.precedenceLookup.set(condition, /* @__PURE__ */ new Set([...orderPrecedence, ...incomingOrderPrecedence]));
    }
  }
  /**
   * Merge another ConditionalRuleset into this one if they are compatible
   *
   * @returns true if successful, false if the ruleset is incompatible
   */
  mergeIfCompatible(incomingRuleset) {
    if (!this.isCompatible(incomingRuleset)) {
      return false;
    }
    this.merge(incomingRuleset);
    return true;
  }
  getSortedRuleset() {
    var _this = this;
    var sortedRuleset = [];
    var _loop = function _loop2(dependents2) {
      var conditionForQuery = _this.ruleset.get(query);
      if (!conditionForQuery) {
        throw new Error("Can't find condition for ".concat(query));
      }
      var firstMatchingDependent = sortedRuleset.findIndex((condition) => dependents2.has(condition.query));
      if (firstMatchingDependent > -1) {
        sortedRuleset.splice(firstMatchingDependent, 0, conditionForQuery);
      } else {
        sortedRuleset.push(conditionForQuery);
      }
    };
    for (var [query, dependents] of this.precedenceLookup.entries()) {
      _loop(dependents);
    }
    return sortedRuleset;
  }
  renderToArray() {
    var arr = [];
    for (var {
      query,
      rules,
      children
    } of this.getSortedRuleset()) {
      var selectors = {};
      for (var rule of rules) {
        selectors[rule.selector] = _objectSpread2$1(_objectSpread2$1({}, selectors[rule.selector]), rule.rule);
      }
      Object.assign(selectors, ...children.renderToArray());
      arr.push({
        [query]: selectors
      });
    }
    return arr;
  }
};
var simplePseudoMap$1 = {
  ":-moz-any-link": true,
  ":-moz-full-screen": true,
  ":-moz-placeholder": true,
  ":-moz-read-only": true,
  ":-moz-read-write": true,
  ":-ms-fullscreen": true,
  ":-ms-input-placeholder": true,
  ":-webkit-any-link": true,
  ":-webkit-full-screen": true,
  "::-moz-color-swatch": true,
  "::-moz-list-bullet": true,
  "::-moz-list-number": true,
  "::-moz-page-sequence": true,
  "::-moz-page": true,
  "::-moz-placeholder": true,
  "::-moz-progress-bar": true,
  "::-moz-range-progress": true,
  "::-moz-range-thumb": true,
  "::-moz-range-track": true,
  "::-moz-scrolled-page-sequence": true,
  "::-moz-selection": true,
  "::-ms-backdrop": true,
  "::-ms-browse": true,
  "::-ms-check": true,
  "::-ms-clear": true,
  "::-ms-fill-lower": true,
  "::-ms-fill-upper": true,
  "::-ms-fill": true,
  "::-ms-reveal": true,
  "::-ms-thumb": true,
  "::-ms-ticks-after": true,
  "::-ms-ticks-before": true,
  "::-ms-tooltip": true,
  "::-ms-track": true,
  "::-ms-value": true,
  "::-webkit-backdrop": true,
  "::-webkit-calendar-picker-indicator": true,
  "::-webkit-inner-spin-button": true,
  "::-webkit-input-placeholder": true,
  "::-webkit-meter-bar": true,
  "::-webkit-meter-even-less-good-value": true,
  "::-webkit-meter-inner-element": true,
  "::-webkit-meter-optimum-value": true,
  "::-webkit-meter-suboptimum-value": true,
  "::-webkit-outer-spin-button": true,
  "::-webkit-progress-bar": true,
  "::-webkit-progress-inner-element": true,
  "::-webkit-progress-inner-value": true,
  "::-webkit-progress-value": true,
  "::-webkit-resizer": true,
  "::-webkit-scrollbar-button": true,
  "::-webkit-scrollbar-corner": true,
  "::-webkit-scrollbar-thumb": true,
  "::-webkit-scrollbar-track-piece": true,
  "::-webkit-scrollbar-track": true,
  "::-webkit-scrollbar": true,
  "::-webkit-search-cancel-button": true,
  "::-webkit-search-results-button": true,
  "::-webkit-slider-runnable-track": true,
  "::-webkit-slider-thumb": true,
  "::after": true,
  "::backdrop": true,
  "::before": true,
  "::cue": true,
  "::file-selector-button": true,
  "::first-letter": true,
  "::first-line": true,
  "::grammar-error": true,
  "::marker": true,
  "::placeholder": true,
  "::selection": true,
  "::spelling-error": true,
  "::target-text": true,
  "::view-transition-group": true,
  "::view-transition-image-pair": true,
  "::view-transition-new": true,
  "::view-transition-old": true,
  "::view-transition": true,
  ":active": true,
  ":after": true,
  ":any-link": true,
  ":before": true,
  ":blank": true,
  ":checked": true,
  ":default": true,
  ":defined": true,
  ":disabled": true,
  ":empty": true,
  ":enabled": true,
  ":first-child": true,
  ":first-letter": true,
  ":first-line": true,
  ":first-of-type": true,
  ":first": true,
  ":focus-visible": true,
  ":focus-within": true,
  ":focus": true,
  ":fullscreen": true,
  ":hover": true,
  ":in-range": true,
  ":indeterminate": true,
  ":invalid": true,
  ":last-child": true,
  ":last-of-type": true,
  ":left": true,
  ":link": true,
  ":only-child": true,
  ":only-of-type": true,
  ":optional": true,
  ":out-of-range": true,
  ":placeholder-shown": true,
  ":read-only": true,
  ":read-write": true,
  ":required": true,
  ":right": true,
  ":root": true,
  ":scope": true,
  ":target": true,
  ":valid": true,
  ":visited": true
};
var simplePseudos$1 = Object.keys(simplePseudoMap$1);
var simplePseudoLookup$1 = simplePseudoMap$1;
var _templateObject$4;
var createMediaQueryError$1 = (mediaQuery, msg) => new Error(dedent$1(_templateObject$4 || (_templateObject$4 = _taggedTemplateLiteral$1(['\n    Invalid media query: "', '"\n\n    ', "\n\n    Read more on MDN: https://developer.mozilla.org/en-US/docs/Web/CSS/Media_Queries/Using_media_queries\n  "])), mediaQuery, msg));
var validateMediaQuery$1 = (mediaQuery) => {
  if (mediaQuery === "@media ") {
    throw createMediaQueryError$1(mediaQuery, "Query is empty");
  }
  try {
    toAST$1(mediaQuery);
  } catch (e) {
    throw createMediaQueryError$1(mediaQuery, e.message);
  }
};
var _excluded$1 = ["vars"], _excluded2$1 = ["content"];
var DECLARATION$1 = "__DECLARATION";
var UNITLESS$1 = {
  animationIterationCount: true,
  borderImage: true,
  borderImageOutset: true,
  borderImageSlice: true,
  borderImageWidth: true,
  boxFlex: true,
  boxFlexGroup: true,
  columnCount: true,
  columns: true,
  flex: true,
  flexGrow: true,
  flexShrink: true,
  fontWeight: true,
  gridArea: true,
  gridColumn: true,
  gridColumnEnd: true,
  gridColumnStart: true,
  gridRow: true,
  gridRowEnd: true,
  gridRowStart: true,
  initialLetter: true,
  lineClamp: true,
  lineHeight: true,
  maxLines: true,
  opacity: true,
  order: true,
  orphans: true,
  scale: true,
  tabSize: true,
  WebkitLineClamp: true,
  widows: true,
  zIndex: true,
  zoom: true,
  // svg properties
  fillOpacity: true,
  floodOpacity: true,
  maskBorder: true,
  maskBorderOutset: true,
  maskBorderSlice: true,
  maskBorderWidth: true,
  shapeImageThreshold: true,
  stopOpacity: true,
  strokeDashoffset: true,
  strokeMiterlimit: true,
  strokeOpacity: true,
  strokeWidth: true
};
function dashify$1(str) {
  return str.replace(/([A-Z])/g, "-$1").replace(/^ms-/, "-ms-").toLowerCase();
}
function replaceBetweenIndexes$1(target, startIndex, endIndex, replacement) {
  var start = target.slice(0, startIndex);
  var end = target.slice(endIndex);
  return "".concat(start).concat(replacement).concat(end);
}
var DOUBLE_SPACE$1 = "  ";
var specialKeys$1 = [...simplePseudos$1, "@layer", "@media", "@supports", "@container", "selectors"];
let Stylesheet$1 = class Stylesheet {
  constructor(localClassNames2, composedClassLists2) {
    this.rules = [];
    this.conditionalRulesets = [new ConditionalRuleset$1()];
    this.fontFaceRules = [];
    this.keyframesRules = [];
    this.propertyRules = [];
    this.localClassNamesMap = new Map(localClassNames2.map((localClassName) => [localClassName, localClassName]));
    this.localClassNamesSearch = new AhoCorasick$1(localClassNames2);
    this.layers = /* @__PURE__ */ new Map();
    this.composedClassLists = composedClassLists2.map((_ref) => {
      var {
        identifier,
        classList
      } = _ref;
      return {
        identifier,
        regex: RegExp("(".concat(classList, ")"), "g")
      };
    }).reverse();
  }
  processCssObj(root) {
    if (root.type === "fontFace") {
      this.fontFaceRules.push(root.rule);
      return;
    }
    if (root.type === "property") {
      this.propertyRules.push(root);
      return;
    }
    if (root.type === "keyframes") {
      root.rule = Object.fromEntries(Object.entries(root.rule).map((_ref2) => {
        var [keyframe, rule] = _ref2;
        return [keyframe, this.transformVars(this.transformProperties(rule))];
      }));
      this.keyframesRules.push(root);
      return;
    }
    this.currConditionalRuleset = new ConditionalRuleset$1();
    if (root.type === "layer") {
      var layerDefinition = "@layer ".concat(root.name);
      this.addLayer([layerDefinition]);
    } else {
      var mainRule = omit$1(root.rule, specialKeys$1);
      this.addRule({
        selector: root.selector,
        rule: mainRule
      });
      this.transformLayer(root, root.rule["@layer"]);
      this.transformMedia(root, root.rule["@media"]);
      this.transformSupports(root, root.rule["@supports"]);
      this.transformContainer(root, root.rule["@container"]);
      this.transformSimplePseudos(root, root.rule);
      this.transformSelectors(root, root.rule);
    }
    var activeConditionalRuleset = this.conditionalRulesets[this.conditionalRulesets.length - 1];
    if (!activeConditionalRuleset.mergeIfCompatible(this.currConditionalRuleset)) {
      this.conditionalRulesets.push(this.currConditionalRuleset);
    }
  }
  addConditionalRule(cssRule, conditions) {
    var rule = this.transformVars(this.transformProperties(cssRule.rule));
    var selector = this.transformSelector(cssRule.selector);
    if (!this.currConditionalRuleset) {
      throw new Error("Couldn't add conditional rule");
    }
    var conditionQuery = conditions[conditions.length - 1];
    var parentConditions = conditions.slice(0, conditions.length - 1);
    this.currConditionalRuleset.addRule({
      selector,
      rule
    }, conditionQuery, parentConditions);
  }
  addRule(cssRule) {
    var rule = this.transformVars(this.transformProperties(cssRule.rule));
    var selector = this.transformSelector(cssRule.selector);
    this.rules.push({
      selector,
      rule
    });
  }
  addLayer(layer) {
    var uniqueLayerKey = layer.join(" - ");
    this.layers.set(uniqueLayerKey, layer);
  }
  transformProperties(cssRule) {
    return this.transformContent(this.pixelifyProperties(cssRule));
  }
  pixelifyProperties(cssRule) {
    forEach$1(cssRule, (value, key) => {
      if (typeof value === "number" && value !== 0 && !UNITLESS$1[key]) {
        cssRule[key] = "".concat(value, "px");
      }
    });
    return cssRule;
  }
  transformVars(_ref3) {
    var {
      vars
    } = _ref3, rest = _objectWithoutProperties$1(_ref3, _excluded$1);
    if (!vars) {
      return rest;
    }
    return _objectSpread2$1(_objectSpread2$1({}, mapKeys$1(vars, (_value, key) => getVarName$2(key))), rest);
  }
  transformContent(_ref4) {
    var {
      content
    } = _ref4, rest = _objectWithoutProperties$1(_ref4, _excluded2$1);
    if (typeof content === "undefined") {
      return rest;
    }
    var contentArray = Array.isArray(content) ? content : [content];
    return _objectSpread2$1({
      content: contentArray.map((value) => (
        // This logic was adapted from Stitches :)
        value && (value.includes('"') || value.includes("'") || /^([A-Za-z\-]+\([^]*|[^]*-quote|inherit|initial|none|normal|revert|unset)(\s|$)/.test(value)) ? value : '"'.concat(value, '"')
      ))
    }, rest);
  }
  transformClassname(identifier) {
    return ".".concat(cssesc$1(identifier, {
      isIdentifier: true
    }));
  }
  transformSelector(selector) {
    var transformedSelector = selector;
    var _loop = function _loop2(identifier2) {
      transformedSelector = transformedSelector.replace(regex, () => {
        markCompositionUsed$1(identifier2);
        return identifier2;
      });
    };
    for (var {
      identifier,
      regex
    } of this.composedClassLists) {
      _loop(identifier);
    }
    if (this.localClassNamesMap.has(transformedSelector)) {
      return this.transformClassname(transformedSelector);
    }
    var results = this.localClassNamesSearch.search(transformedSelector);
    var lastReplaceIndex = transformedSelector.length;
    for (var i = results.length - 1; i >= 0; i--) {
      var [endIndex, [firstMatch]] = results[i];
      var startIndex = endIndex - firstMatch.length + 1;
      var skipReplacement = lastReplaceIndex <= endIndex;
      if (skipReplacement) {
        continue;
      }
      lastReplaceIndex = startIndex;
      if (transformedSelector[startIndex - 1] !== ".") {
        transformedSelector = replaceBetweenIndexes$1(transformedSelector, startIndex, endIndex + 1, this.transformClassname(firstMatch));
      }
    }
    return transformedSelector;
  }
  transformSelectors(root, rule, conditions) {
    forEach$1(rule.selectors, (selectorRule, selector) => {
      if (root.type !== "local") {
        throw new Error("Selectors are not allowed within ".concat(root.type === "global" ? '"globalStyle"' : '"selectors"'));
      }
      var transformedSelector = this.transformSelector(selector.replace(RegExp("&", "g"), root.selector));
      validateSelector$1(transformedSelector, root.selector);
      var rule2 = {
        selector: transformedSelector,
        rule: omit$1(selectorRule, specialKeys$1)
      };
      if (conditions) {
        this.addConditionalRule(rule2, conditions);
      } else {
        this.addRule(rule2);
      }
      var selectorRoot = {
        type: "selector",
        selector: transformedSelector,
        rule: selectorRule
      };
      this.transformLayer(selectorRoot, selectorRule["@layer"], conditions);
      this.transformSupports(selectorRoot, selectorRule["@supports"], conditions);
      this.transformMedia(selectorRoot, selectorRule["@media"], conditions);
      this.transformContainer(selectorRoot, selectorRule["@container"], conditions);
    });
  }
  transformMedia(root, rules) {
    var parentConditions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
    if (rules) {
      var _this$currConditional;
      (_this$currConditional = this.currConditionalRuleset) === null || _this$currConditional === void 0 || _this$currConditional.addConditionPrecedence(parentConditions, Object.keys(rules).map((query2) => "@media ".concat(query2)));
      for (var [query, mediaRule] of Object.entries(rules)) {
        var mediaQuery = "@media ".concat(query);
        validateMediaQuery$1(mediaQuery);
        var conditions = [...parentConditions, mediaQuery];
        this.addConditionalRule({
          selector: root.selector,
          rule: omit$1(mediaRule, specialKeys$1)
        }, conditions);
        if (root.type === "local") {
          this.transformSimplePseudos(root, mediaRule, conditions);
          this.transformSelectors(root, mediaRule, conditions);
        }
        this.transformLayer(root, mediaRule["@layer"], conditions);
        this.transformSupports(root, mediaRule["@supports"], conditions);
        this.transformContainer(root, mediaRule["@container"], conditions);
      }
    }
  }
  transformContainer(root, rules) {
    var parentConditions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
    if (rules) {
      var _this$currConditional2;
      (_this$currConditional2 = this.currConditionalRuleset) === null || _this$currConditional2 === void 0 || _this$currConditional2.addConditionPrecedence(parentConditions, Object.keys(rules).map((query) => "@container ".concat(query)));
      forEach$1(rules, (containerRule, query) => {
        var containerQuery = "@container ".concat(query);
        var conditions = [...parentConditions, containerQuery];
        this.addConditionalRule({
          selector: root.selector,
          rule: omit$1(containerRule, specialKeys$1)
        }, conditions);
        if (root.type === "local") {
          this.transformSimplePseudos(root, containerRule, conditions);
          this.transformSelectors(root, containerRule, conditions);
        }
        this.transformLayer(root, containerRule["@layer"], conditions);
        this.transformSupports(root, containerRule["@supports"], conditions);
        this.transformMedia(root, containerRule["@media"], conditions);
      });
    }
  }
  transformLayer(root, rules) {
    var parentConditions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
    if (rules) {
      var _this$currConditional3;
      (_this$currConditional3 = this.currConditionalRuleset) === null || _this$currConditional3 === void 0 || _this$currConditional3.addConditionPrecedence(parentConditions, Object.keys(rules).map((name) => "@layer ".concat(name)));
      forEach$1(rules, (layerRule, name) => {
        var conditions = [...parentConditions, "@layer ".concat(name)];
        this.addLayer(conditions);
        this.addConditionalRule({
          selector: root.selector,
          rule: omit$1(layerRule, specialKeys$1)
        }, conditions);
        if (root.type === "local") {
          this.transformSimplePseudos(root, layerRule, conditions);
          this.transformSelectors(root, layerRule, conditions);
        }
        this.transformMedia(root, layerRule["@media"], conditions);
        this.transformSupports(root, layerRule["@supports"], conditions);
        this.transformContainer(root, layerRule["@container"], conditions);
      });
    }
  }
  transformSupports(root, rules) {
    var parentConditions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
    if (rules) {
      var _this$currConditional4;
      (_this$currConditional4 = this.currConditionalRuleset) === null || _this$currConditional4 === void 0 || _this$currConditional4.addConditionPrecedence(parentConditions, Object.keys(rules).map((query) => "@supports ".concat(query)));
      forEach$1(rules, (supportsRule, query) => {
        var conditions = [...parentConditions, "@supports ".concat(query)];
        this.addConditionalRule({
          selector: root.selector,
          rule: omit$1(supportsRule, specialKeys$1)
        }, conditions);
        if (root.type === "local") {
          this.transformSimplePseudos(root, supportsRule, conditions);
          this.transformSelectors(root, supportsRule, conditions);
        }
        this.transformLayer(root, supportsRule["@layer"], conditions);
        this.transformMedia(root, supportsRule["@media"], conditions);
        this.transformContainer(root, supportsRule["@container"], conditions);
      });
    }
  }
  transformSimplePseudos(root, rule, conditions) {
    for (var key of Object.keys(rule)) {
      if (simplePseudoLookup$1[key]) {
        if (root.type !== "local") {
          throw new Error("Simple pseudos are not valid in ".concat(root.type === "global" ? '"globalStyle"' : '"selectors"'));
        }
        if (conditions) {
          this.addConditionalRule({
            selector: "".concat(root.selector).concat(key),
            rule: rule[key]
          }, conditions);
        } else {
          this.addRule({
            conditions,
            selector: "".concat(root.selector).concat(key),
            rule: rule[key]
          });
        }
      }
    }
  }
  toCss() {
    var css2 = [];
    for (var fontFaceRule of this.fontFaceRules) {
      css2.push(renderCss$1({
        "@font-face": fontFaceRule
      }));
    }
    for (var property of this.propertyRules) {
      css2.push(renderCss$1({
        ["@property ".concat(property.name)]: property.rule
      }));
    }
    for (var keyframe of this.keyframesRules) {
      css2.push(renderCss$1({
        ["@keyframes ".concat(keyframe.name)]: keyframe.rule
      }));
    }
    for (var layer of this.layers.values()) {
      var [definition, ...nesting] = layer.reverse();
      var cssObj = {
        [definition]: DECLARATION$1
      };
      for (var part of nesting) {
        cssObj = {
          [part]: cssObj
        };
      }
      css2.push(renderCss$1(cssObj));
    }
    for (var rule of this.rules) {
      css2.push(renderCss$1({
        [rule.selector]: rule.rule
      }));
    }
    for (var conditionalRuleset of this.conditionalRulesets) {
      for (var conditionalRule of conditionalRuleset.renderToArray()) {
        css2.push(renderCss$1(conditionalRule));
      }
    }
    return css2.filter(Boolean);
  }
};
function renderCss$1(v) {
  var indent = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : "";
  var rules = [];
  var _loop2 = function _loop22(key2) {
    var value = v[key2];
    if (value && Array.isArray(value)) {
      rules.push(...value.map((v2) => renderCss$1({
        [key2]: v2
      }, indent)));
    } else if (value && typeof value === "object") {
      var isEmpty = Object.keys(value).length === 0;
      if (!isEmpty) {
        rules.push("".concat(indent).concat(key2, " {\n").concat(renderCss$1(value, indent + DOUBLE_SPACE$1), "\n").concat(indent, "}"));
      }
    } else if (value === DECLARATION$1) {
      rules.push("".concat(indent).concat(key2, ";"));
    } else {
      rules.push("".concat(indent).concat(key2.startsWith("--") ? key2 : dashify$1(key2), ": ").concat(value, ";"));
    }
  };
  for (var key of Object.keys(v)) {
    _loop2(key);
  }
  return rules.join("\n");
}
function transformCss$1(_ref5) {
  var {
    localClassNames: localClassNames2,
    cssObjs,
    composedClassLists: composedClassLists2
  } = _ref5;
  var stylesheet = new Stylesheet$1(localClassNames2, composedClassLists2);
  for (var root of cssObjs) {
    stylesheet.processCssObj(root);
  }
  return stylesheet.toCss();
}
function murmur2$1(str) {
  var h = 0;
  var k, i = 0, len = str.length;
  for (; len >= 4; ++i, len -= 4) {
    k = str.charCodeAt(i) & 255 | (str.charCodeAt(++i) & 255) << 8 | (str.charCodeAt(++i) & 255) << 16 | (str.charCodeAt(++i) & 255) << 24;
    k = /* Math.imul(k, m): */
    (k & 65535) * 1540483477 + ((k >>> 16) * 59797 << 16);
    k ^= /* k >>> r: */
    k >>> 24;
    h = /* Math.imul(k, m): */
    (k & 65535) * 1540483477 + ((k >>> 16) * 59797 << 16) ^ /* Math.imul(h, m): */
    (h & 65535) * 1540483477 + ((h >>> 16) * 59797 << 16);
  }
  switch (len) {
    case 3:
      h ^= (str.charCodeAt(i + 2) & 255) << 16;
    case 2:
      h ^= (str.charCodeAt(i + 1) & 255) << 8;
    case 1:
      h ^= str.charCodeAt(i) & 255;
      h = /* Math.imul(h, m): */
      (h & 65535) * 1540483477 + ((h >>> 16) * 59797 << 16);
  }
  h ^= h >>> 13;
  h = /* Math.imul(h, m): */
  (h & 65535) * 1540483477 + ((h >>> 16) * 59797 << 16);
  return ((h ^ h >>> 15) >>> 0).toString(36);
}
var _templateObject$3;
var refCounter$1 = 0;
var fileScopes$1 = [];
function getFileScope$1() {
  if (fileScopes$1.length === 0) {
    throw new Error(dedent$1(_templateObject$3 || (_templateObject$3 = _taggedTemplateLiteral$1(["\n        Styles were unable to be assigned to a file. This is generally caused by one of the following:\n\n        - You may have created styles outside of a '.css.ts' context\n        - You may have incorrect configuration. See https://vanilla-extract.style/documentation/getting-started\n      "]))));
  }
  return fileScopes$1[0];
}
function getAndIncrementRefCounter$1() {
  return refCounter$1++;
}
const perf$1 = typeof performance === "object" && performance && typeof performance.now === "function" ? performance : Date;
const warned$1 = /* @__PURE__ */ new Set();
const PROCESS$1 = typeof process === "object" && !!process ? process : {};
const emitWarning$1 = (msg, type, code, fn) => {
  typeof PROCESS$1.emitWarning === "function" ? PROCESS$1.emitWarning(msg, type, code, fn) : console.error(`[${code}] ${type}: ${msg}`);
};
let AC$1 = globalThis.AbortController;
let AS$1 = globalThis.AbortSignal;
if (typeof AC$1 === "undefined") {
  AS$1 = class AbortSignal {
    onabort;
    _onabort = [];
    reason;
    aborted = false;
    addEventListener(_, fn) {
      this._onabort.push(fn);
    }
  };
  AC$1 = class AbortController {
    constructor() {
      warnACPolyfill();
    }
    signal = new AS$1();
    abort(reason) {
      if (this.signal.aborted)
        return;
      this.signal.reason = reason;
      this.signal.aborted = true;
      for (const fn of this.signal._onabort) {
        fn(reason);
      }
      this.signal.onabort?.(reason);
    }
  };
  let printACPolyfillWarning = PROCESS$1.env?.LRU_CACHE_IGNORE_AC_WARNING !== "1";
  const warnACPolyfill = () => {
    if (!printACPolyfillWarning)
      return;
    printACPolyfillWarning = false;
    emitWarning$1("AbortController is not defined. If using lru-cache in node 14, load an AbortController polyfill from the `node-abort-controller` package. A minimal polyfill is provided for use by LRUCache.fetch(), but it should not be relied upon in other contexts (eg, passing it to other APIs that use AbortController/AbortSignal might have undesirable effects). You may disable this with LRU_CACHE_IGNORE_AC_WARNING=1 in the env.", "NO_ABORT_CONTROLLER", "ENOTSUP", warnACPolyfill);
  };
}
const shouldWarn$1 = (code) => !warned$1.has(code);
const isPosInt$1 = (n) => n && n === Math.floor(n) && n > 0 && isFinite(n);
const getUintArray$1 = (max) => !isPosInt$1(max) ? null : max <= Math.pow(2, 8) ? Uint8Array : max <= Math.pow(2, 16) ? Uint16Array : max <= Math.pow(2, 32) ? Uint32Array : max <= Number.MAX_SAFE_INTEGER ? ZeroArray$1 : null;
let ZeroArray$1 = class ZeroArray extends Array {
  constructor(size) {
    super(size);
    this.fill(0);
  }
};
let Stack$1 = class Stack {
  heap;
  length;
  // private constructor
  static #constructing = false;
  static create(max) {
    const HeapCls = getUintArray$1(max);
    if (!HeapCls)
      return [];
    Stack.#constructing = true;
    const s = new Stack(max, HeapCls);
    Stack.#constructing = false;
    return s;
  }
  constructor(max, HeapCls) {
    if (!Stack.#constructing) {
      throw new TypeError("instantiate Stack using Stack.create(n)");
    }
    this.heap = new HeapCls(max);
    this.length = 0;
  }
  push(n) {
    this.heap[this.length++] = n;
  }
  pop() {
    return this.heap[--this.length];
  }
};
let LRUCache$1 = class LRUCache {
  // options that cannot be changed without disaster
  #max;
  #maxSize;
  #dispose;
  #disposeAfter;
  #fetchMethod;
  #memoMethod;
  /**
   * {@link LRUCache.OptionsBase.ttl}
   */
  ttl;
  /**
   * {@link LRUCache.OptionsBase.ttlResolution}
   */
  ttlResolution;
  /**
   * {@link LRUCache.OptionsBase.ttlAutopurge}
   */
  ttlAutopurge;
  /**
   * {@link LRUCache.OptionsBase.updateAgeOnGet}
   */
  updateAgeOnGet;
  /**
   * {@link LRUCache.OptionsBase.updateAgeOnHas}
   */
  updateAgeOnHas;
  /**
   * {@link LRUCache.OptionsBase.allowStale}
   */
  allowStale;
  /**
   * {@link LRUCache.OptionsBase.noDisposeOnSet}
   */
  noDisposeOnSet;
  /**
   * {@link LRUCache.OptionsBase.noUpdateTTL}
   */
  noUpdateTTL;
  /**
   * {@link LRUCache.OptionsBase.maxEntrySize}
   */
  maxEntrySize;
  /**
   * {@link LRUCache.OptionsBase.sizeCalculation}
   */
  sizeCalculation;
  /**
   * {@link LRUCache.OptionsBase.noDeleteOnFetchRejection}
   */
  noDeleteOnFetchRejection;
  /**
   * {@link LRUCache.OptionsBase.noDeleteOnStaleGet}
   */
  noDeleteOnStaleGet;
  /**
   * {@link LRUCache.OptionsBase.allowStaleOnFetchAbort}
   */
  allowStaleOnFetchAbort;
  /**
   * {@link LRUCache.OptionsBase.allowStaleOnFetchRejection}
   */
  allowStaleOnFetchRejection;
  /**
   * {@link LRUCache.OptionsBase.ignoreFetchAbort}
   */
  ignoreFetchAbort;
  // computed properties
  #size;
  #calculatedSize;
  #keyMap;
  #keyList;
  #valList;
  #next;
  #prev;
  #head;
  #tail;
  #free;
  #disposed;
  #sizes;
  #starts;
  #ttls;
  #hasDispose;
  #hasFetchMethod;
  #hasDisposeAfter;
  /**
   * Do not call this method unless you need to inspect the
   * inner workings of the cache.  If anything returned by this
   * object is modified in any way, strange breakage may occur.
   *
   * These fields are private for a reason!
   *
   * @internal
   */
  static unsafeExposeInternals(c) {
    return {
      // properties
      starts: c.#starts,
      ttls: c.#ttls,
      sizes: c.#sizes,
      keyMap: c.#keyMap,
      keyList: c.#keyList,
      valList: c.#valList,
      next: c.#next,
      prev: c.#prev,
      get head() {
        return c.#head;
      },
      get tail() {
        return c.#tail;
      },
      free: c.#free,
      // methods
      isBackgroundFetch: (p) => c.#isBackgroundFetch(p),
      backgroundFetch: (k, index, options, context) => c.#backgroundFetch(k, index, options, context),
      moveToTail: (index) => c.#moveToTail(index),
      indexes: (options) => c.#indexes(options),
      rindexes: (options) => c.#rindexes(options),
      isStale: (index) => c.#isStale(index)
    };
  }
  // Protected read-only members
  /**
   * {@link LRUCache.OptionsBase.max} (read-only)
   */
  get max() {
    return this.#max;
  }
  /**
   * {@link LRUCache.OptionsBase.maxSize} (read-only)
   */
  get maxSize() {
    return this.#maxSize;
  }
  /**
   * The total computed size of items in the cache (read-only)
   */
  get calculatedSize() {
    return this.#calculatedSize;
  }
  /**
   * The number of items stored in the cache (read-only)
   */
  get size() {
    return this.#size;
  }
  /**
   * {@link LRUCache.OptionsBase.fetchMethod} (read-only)
   */
  get fetchMethod() {
    return this.#fetchMethod;
  }
  get memoMethod() {
    return this.#memoMethod;
  }
  /**
   * {@link LRUCache.OptionsBase.dispose} (read-only)
   */
  get dispose() {
    return this.#dispose;
  }
  /**
   * {@link LRUCache.OptionsBase.disposeAfter} (read-only)
   */
  get disposeAfter() {
    return this.#disposeAfter;
  }
  constructor(options) {
    const { max = 0, ttl, ttlResolution = 1, ttlAutopurge, updateAgeOnGet, updateAgeOnHas, allowStale, dispose, disposeAfter, noDisposeOnSet, noUpdateTTL, maxSize = 0, maxEntrySize = 0, sizeCalculation, fetchMethod, memoMethod, noDeleteOnFetchRejection, noDeleteOnStaleGet, allowStaleOnFetchRejection, allowStaleOnFetchAbort, ignoreFetchAbort } = options;
    if (max !== 0 && !isPosInt$1(max)) {
      throw new TypeError("max option must be a nonnegative integer");
    }
    const UintArray = max ? getUintArray$1(max) : Array;
    if (!UintArray) {
      throw new Error("invalid max value: " + max);
    }
    this.#max = max;
    this.#maxSize = maxSize;
    this.maxEntrySize = maxEntrySize || this.#maxSize;
    this.sizeCalculation = sizeCalculation;
    if (this.sizeCalculation) {
      if (!this.#maxSize && !this.maxEntrySize) {
        throw new TypeError("cannot set sizeCalculation without setting maxSize or maxEntrySize");
      }
      if (typeof this.sizeCalculation !== "function") {
        throw new TypeError("sizeCalculation set to non-function");
      }
    }
    if (memoMethod !== void 0 && typeof memoMethod !== "function") {
      throw new TypeError("memoMethod must be a function if defined");
    }
    this.#memoMethod = memoMethod;
    if (fetchMethod !== void 0 && typeof fetchMethod !== "function") {
      throw new TypeError("fetchMethod must be a function if specified");
    }
    this.#fetchMethod = fetchMethod;
    this.#hasFetchMethod = !!fetchMethod;
    this.#keyMap = /* @__PURE__ */ new Map();
    this.#keyList = new Array(max).fill(void 0);
    this.#valList = new Array(max).fill(void 0);
    this.#next = new UintArray(max);
    this.#prev = new UintArray(max);
    this.#head = 0;
    this.#tail = 0;
    this.#free = Stack$1.create(max);
    this.#size = 0;
    this.#calculatedSize = 0;
    if (typeof dispose === "function") {
      this.#dispose = dispose;
    }
    if (typeof disposeAfter === "function") {
      this.#disposeAfter = disposeAfter;
      this.#disposed = [];
    } else {
      this.#disposeAfter = void 0;
      this.#disposed = void 0;
    }
    this.#hasDispose = !!this.#dispose;
    this.#hasDisposeAfter = !!this.#disposeAfter;
    this.noDisposeOnSet = !!noDisposeOnSet;
    this.noUpdateTTL = !!noUpdateTTL;
    this.noDeleteOnFetchRejection = !!noDeleteOnFetchRejection;
    this.allowStaleOnFetchRejection = !!allowStaleOnFetchRejection;
    this.allowStaleOnFetchAbort = !!allowStaleOnFetchAbort;
    this.ignoreFetchAbort = !!ignoreFetchAbort;
    if (this.maxEntrySize !== 0) {
      if (this.#maxSize !== 0) {
        if (!isPosInt$1(this.#maxSize)) {
          throw new TypeError("maxSize must be a positive integer if specified");
        }
      }
      if (!isPosInt$1(this.maxEntrySize)) {
        throw new TypeError("maxEntrySize must be a positive integer if specified");
      }
      this.#initializeSizeTracking();
    }
    this.allowStale = !!allowStale;
    this.noDeleteOnStaleGet = !!noDeleteOnStaleGet;
    this.updateAgeOnGet = !!updateAgeOnGet;
    this.updateAgeOnHas = !!updateAgeOnHas;
    this.ttlResolution = isPosInt$1(ttlResolution) || ttlResolution === 0 ? ttlResolution : 1;
    this.ttlAutopurge = !!ttlAutopurge;
    this.ttl = ttl || 0;
    if (this.ttl) {
      if (!isPosInt$1(this.ttl)) {
        throw new TypeError("ttl must be a positive integer if specified");
      }
      this.#initializeTTLTracking();
    }
    if (this.#max === 0 && this.ttl === 0 && this.#maxSize === 0) {
      throw new TypeError("At least one of max, maxSize, or ttl is required");
    }
    if (!this.ttlAutopurge && !this.#max && !this.#maxSize) {
      const code = "LRU_CACHE_UNBOUNDED";
      if (shouldWarn$1(code)) {
        warned$1.add(code);
        const msg = "TTL caching without ttlAutopurge, max, or maxSize can result in unbounded memory consumption.";
        emitWarning$1(msg, "UnboundedCacheWarning", code, LRUCache);
      }
    }
  }
  /**
   * Return the number of ms left in the item's TTL. If item is not in cache,
   * returns `0`. Returns `Infinity` if item is in cache without a defined TTL.
   */
  getRemainingTTL(key) {
    return this.#keyMap.has(key) ? Infinity : 0;
  }
  #initializeTTLTracking() {
    const ttls = new ZeroArray$1(this.#max);
    const starts = new ZeroArray$1(this.#max);
    this.#ttls = ttls;
    this.#starts = starts;
    this.#setItemTTL = (index, ttl, start = perf$1.now()) => {
      starts[index] = ttl !== 0 ? start : 0;
      ttls[index] = ttl;
      if (ttl !== 0 && this.ttlAutopurge) {
        const t = setTimeout(() => {
          if (this.#isStale(index)) {
            this.#delete(this.#keyList[index], "expire");
          }
        }, ttl + 1);
        if (t.unref) {
          t.unref();
        }
      }
    };
    this.#updateItemAge = (index) => {
      starts[index] = ttls[index] !== 0 ? perf$1.now() : 0;
    };
    this.#statusTTL = (status, index) => {
      if (ttls[index]) {
        const ttl = ttls[index];
        const start = starts[index];
        if (!ttl || !start)
          return;
        status.ttl = ttl;
        status.start = start;
        status.now = cachedNow || getNow();
        const age = status.now - start;
        status.remainingTTL = ttl - age;
      }
    };
    let cachedNow = 0;
    const getNow = () => {
      const n = perf$1.now();
      if (this.ttlResolution > 0) {
        cachedNow = n;
        const t = setTimeout(() => cachedNow = 0, this.ttlResolution);
        if (t.unref) {
          t.unref();
        }
      }
      return n;
    };
    this.getRemainingTTL = (key) => {
      const index = this.#keyMap.get(key);
      if (index === void 0) {
        return 0;
      }
      const ttl = ttls[index];
      const start = starts[index];
      if (!ttl || !start) {
        return Infinity;
      }
      const age = (cachedNow || getNow()) - start;
      return ttl - age;
    };
    this.#isStale = (index) => {
      const s = starts[index];
      const t = ttls[index];
      return !!t && !!s && (cachedNow || getNow()) - s > t;
    };
  }
  // conditionally set private methods related to TTL
  #updateItemAge = () => {
  };
  #statusTTL = () => {
  };
  #setItemTTL = () => {
  };
  /* c8 ignore stop */
  #isStale = () => false;
  #initializeSizeTracking() {
    const sizes = new ZeroArray$1(this.#max);
    this.#calculatedSize = 0;
    this.#sizes = sizes;
    this.#removeItemSize = (index) => {
      this.#calculatedSize -= sizes[index];
      sizes[index] = 0;
    };
    this.#requireSize = (k, v, size, sizeCalculation) => {
      if (this.#isBackgroundFetch(v)) {
        return 0;
      }
      if (!isPosInt$1(size)) {
        if (sizeCalculation) {
          if (typeof sizeCalculation !== "function") {
            throw new TypeError("sizeCalculation must be a function");
          }
          size = sizeCalculation(v, k);
          if (!isPosInt$1(size)) {
            throw new TypeError("sizeCalculation return invalid (expect positive integer)");
          }
        } else {
          throw new TypeError("invalid size value (must be positive integer). When maxSize or maxEntrySize is used, sizeCalculation or size must be set.");
        }
      }
      return size;
    };
    this.#addItemSize = (index, size, status) => {
      sizes[index] = size;
      if (this.#maxSize) {
        const maxSize = this.#maxSize - sizes[index];
        while (this.#calculatedSize > maxSize) {
          this.#evict(true);
        }
      }
      this.#calculatedSize += sizes[index];
      if (status) {
        status.entrySize = size;
        status.totalCalculatedSize = this.#calculatedSize;
      }
    };
  }
  #removeItemSize = (_i) => {
  };
  #addItemSize = (_i, _s, _st) => {
  };
  #requireSize = (_k, _v, size, sizeCalculation) => {
    if (size || sizeCalculation) {
      throw new TypeError("cannot set size without setting maxSize or maxEntrySize on cache");
    }
    return 0;
  };
  *#indexes({ allowStale = this.allowStale } = {}) {
    if (this.#size) {
      for (let i = this.#tail; true; ) {
        if (!this.#isValidIndex(i)) {
          break;
        }
        if (allowStale || !this.#isStale(i)) {
          yield i;
        }
        if (i === this.#head) {
          break;
        } else {
          i = this.#prev[i];
        }
      }
    }
  }
  *#rindexes({ allowStale = this.allowStale } = {}) {
    if (this.#size) {
      for (let i = this.#head; true; ) {
        if (!this.#isValidIndex(i)) {
          break;
        }
        if (allowStale || !this.#isStale(i)) {
          yield i;
        }
        if (i === this.#tail) {
          break;
        } else {
          i = this.#next[i];
        }
      }
    }
  }
  #isValidIndex(index) {
    return index !== void 0 && this.#keyMap.get(this.#keyList[index]) === index;
  }
  /**
   * Return a generator yielding `[key, value]` pairs,
   * in order from most recently used to least recently used.
   */
  *entries() {
    for (const i of this.#indexes()) {
      if (this.#valList[i] !== void 0 && this.#keyList[i] !== void 0 && !this.#isBackgroundFetch(this.#valList[i])) {
        yield [this.#keyList[i], this.#valList[i]];
      }
    }
  }
  /**
   * Inverse order version of {@link LRUCache.entries}
   *
   * Return a generator yielding `[key, value]` pairs,
   * in order from least recently used to most recently used.
   */
  *rentries() {
    for (const i of this.#rindexes()) {
      if (this.#valList[i] !== void 0 && this.#keyList[i] !== void 0 && !this.#isBackgroundFetch(this.#valList[i])) {
        yield [this.#keyList[i], this.#valList[i]];
      }
    }
  }
  /**
   * Return a generator yielding the keys in the cache,
   * in order from most recently used to least recently used.
   */
  *keys() {
    for (const i of this.#indexes()) {
      const k = this.#keyList[i];
      if (k !== void 0 && !this.#isBackgroundFetch(this.#valList[i])) {
        yield k;
      }
    }
  }
  /**
   * Inverse order version of {@link LRUCache.keys}
   *
   * Return a generator yielding the keys in the cache,
   * in order from least recently used to most recently used.
   */
  *rkeys() {
    for (const i of this.#rindexes()) {
      const k = this.#keyList[i];
      if (k !== void 0 && !this.#isBackgroundFetch(this.#valList[i])) {
        yield k;
      }
    }
  }
  /**
   * Return a generator yielding the values in the cache,
   * in order from most recently used to least recently used.
   */
  *values() {
    for (const i of this.#indexes()) {
      const v = this.#valList[i];
      if (v !== void 0 && !this.#isBackgroundFetch(this.#valList[i])) {
        yield this.#valList[i];
      }
    }
  }
  /**
   * Inverse order version of {@link LRUCache.values}
   *
   * Return a generator yielding the values in the cache,
   * in order from least recently used to most recently used.
   */
  *rvalues() {
    for (const i of this.#rindexes()) {
      const v = this.#valList[i];
      if (v !== void 0 && !this.#isBackgroundFetch(this.#valList[i])) {
        yield this.#valList[i];
      }
    }
  }
  /**
   * Iterating over the cache itself yields the same results as
   * {@link LRUCache.entries}
   */
  [Symbol.iterator]() {
    return this.entries();
  }
  /**
   * A String value that is used in the creation of the default string
   * description of an object. Called by the built-in method
   * `Object.prototype.toString`.
   */
  [Symbol.toStringTag] = "LRUCache";
  /**
   * Find a value for which the supplied fn method returns a truthy value,
   * similar to `Array.find()`. fn is called as `fn(value, key, cache)`.
   */
  find(fn, getOptions = {}) {
    for (const i of this.#indexes()) {
      const v = this.#valList[i];
      const value = this.#isBackgroundFetch(v) ? v.__staleWhileFetching : v;
      if (value === void 0)
        continue;
      if (fn(value, this.#keyList[i], this)) {
        return this.get(this.#keyList[i], getOptions);
      }
    }
  }
  /**
   * Call the supplied function on each item in the cache, in order from most
   * recently used to least recently used.
   *
   * `fn` is called as `fn(value, key, cache)`.
   *
   * If `thisp` is provided, function will be called in the `this`-context of
   * the provided object, or the cache if no `thisp` object is provided.
   *
   * Does not update age or recenty of use, or iterate over stale values.
   */
  forEach(fn, thisp = this) {
    for (const i of this.#indexes()) {
      const v = this.#valList[i];
      const value = this.#isBackgroundFetch(v) ? v.__staleWhileFetching : v;
      if (value === void 0)
        continue;
      fn.call(thisp, value, this.#keyList[i], this);
    }
  }
  /**
   * The same as {@link LRUCache.forEach} but items are iterated over in
   * reverse order.  (ie, less recently used items are iterated over first.)
   */
  rforEach(fn, thisp = this) {
    for (const i of this.#rindexes()) {
      const v = this.#valList[i];
      const value = this.#isBackgroundFetch(v) ? v.__staleWhileFetching : v;
      if (value === void 0)
        continue;
      fn.call(thisp, value, this.#keyList[i], this);
    }
  }
  /**
   * Delete any stale entries. Returns true if anything was removed,
   * false otherwise.
   */
  purgeStale() {
    let deleted = false;
    for (const i of this.#rindexes({ allowStale: true })) {
      if (this.#isStale(i)) {
        this.#delete(this.#keyList[i], "expire");
        deleted = true;
      }
    }
    return deleted;
  }
  /**
   * Get the extended info about a given entry, to get its value, size, and
   * TTL info simultaneously. Returns `undefined` if the key is not present.
   *
   * Unlike {@link LRUCache#dump}, which is designed to be portable and survive
   * serialization, the `start` value is always the current timestamp, and the
   * `ttl` is a calculated remaining time to live (negative if expired).
   *
   * Always returns stale values, if their info is found in the cache, so be
   * sure to check for expirations (ie, a negative {@link LRUCache.Entry#ttl})
   * if relevant.
   */
  info(key) {
    const i = this.#keyMap.get(key);
    if (i === void 0)
      return void 0;
    const v = this.#valList[i];
    const value = this.#isBackgroundFetch(v) ? v.__staleWhileFetching : v;
    if (value === void 0)
      return void 0;
    const entry = { value };
    if (this.#ttls && this.#starts) {
      const ttl = this.#ttls[i];
      const start = this.#starts[i];
      if (ttl && start) {
        const remain = ttl - (perf$1.now() - start);
        entry.ttl = remain;
        entry.start = Date.now();
      }
    }
    if (this.#sizes) {
      entry.size = this.#sizes[i];
    }
    return entry;
  }
  /**
   * Return an array of [key, {@link LRUCache.Entry}] tuples which can be
   * passed to {@link LRLUCache#load}.
   *
   * The `start` fields are calculated relative to a portable `Date.now()`
   * timestamp, even if `performance.now()` is available.
   *
   * Stale entries are always included in the `dump`, even if
   * {@link LRUCache.OptionsBase.allowStale} is false.
   *
   * Note: this returns an actual array, not a generator, so it can be more
   * easily passed around.
   */
  dump() {
    const arr = [];
    for (const i of this.#indexes({ allowStale: true })) {
      const key = this.#keyList[i];
      const v = this.#valList[i];
      const value = this.#isBackgroundFetch(v) ? v.__staleWhileFetching : v;
      if (value === void 0 || key === void 0)
        continue;
      const entry = { value };
      if (this.#ttls && this.#starts) {
        entry.ttl = this.#ttls[i];
        const age = perf$1.now() - this.#starts[i];
        entry.start = Math.floor(Date.now() - age);
      }
      if (this.#sizes) {
        entry.size = this.#sizes[i];
      }
      arr.unshift([key, entry]);
    }
    return arr;
  }
  /**
   * Reset the cache and load in the items in entries in the order listed.
   *
   * The shape of the resulting cache may be different if the same options are
   * not used in both caches.
   *
   * The `start` fields are assumed to be calculated relative to a portable
   * `Date.now()` timestamp, even if `performance.now()` is available.
   */
  load(arr) {
    this.clear();
    for (const [key, entry] of arr) {
      if (entry.start) {
        const age = Date.now() - entry.start;
        entry.start = perf$1.now() - age;
      }
      this.set(key, entry.value, entry);
    }
  }
  /**
   * Add a value to the cache.
   *
   * Note: if `undefined` is specified as a value, this is an alias for
   * {@link LRUCache#delete}
   *
   * Fields on the {@link LRUCache.SetOptions} options param will override
   * their corresponding values in the constructor options for the scope
   * of this single `set()` operation.
   *
   * If `start` is provided, then that will set the effective start
   * time for the TTL calculation. Note that this must be a previous
   * value of `performance.now()` if supported, or a previous value of
   * `Date.now()` if not.
   *
   * Options object may also include `size`, which will prevent
   * calling the `sizeCalculation` function and just use the specified
   * number if it is a positive integer, and `noDisposeOnSet` which
   * will prevent calling a `dispose` function in the case of
   * overwrites.
   *
   * If the `size` (or return value of `sizeCalculation`) for a given
   * entry is greater than `maxEntrySize`, then the item will not be
   * added to the cache.
   *
   * Will update the recency of the entry.
   *
   * If the value is `undefined`, then this is an alias for
   * `cache.delete(key)`. `undefined` is never stored in the cache.
   */
  set(k, v, setOptions = {}) {
    if (v === void 0) {
      this.delete(k);
      return this;
    }
    const { ttl = this.ttl, start, noDisposeOnSet = this.noDisposeOnSet, sizeCalculation = this.sizeCalculation, status } = setOptions;
    let { noUpdateTTL = this.noUpdateTTL } = setOptions;
    const size = this.#requireSize(k, v, setOptions.size || 0, sizeCalculation);
    if (this.maxEntrySize && size > this.maxEntrySize) {
      if (status) {
        status.set = "miss";
        status.maxEntrySizeExceeded = true;
      }
      this.#delete(k, "set");
      return this;
    }
    let index = this.#size === 0 ? void 0 : this.#keyMap.get(k);
    if (index === void 0) {
      index = this.#size === 0 ? this.#tail : this.#free.length !== 0 ? this.#free.pop() : this.#size === this.#max ? this.#evict(false) : this.#size;
      this.#keyList[index] = k;
      this.#valList[index] = v;
      this.#keyMap.set(k, index);
      this.#next[this.#tail] = index;
      this.#prev[index] = this.#tail;
      this.#tail = index;
      this.#size++;
      this.#addItemSize(index, size, status);
      if (status)
        status.set = "add";
      noUpdateTTL = false;
    } else {
      this.#moveToTail(index);
      const oldVal = this.#valList[index];
      if (v !== oldVal) {
        if (this.#hasFetchMethod && this.#isBackgroundFetch(oldVal)) {
          oldVal.__abortController.abort(new Error("replaced"));
          const { __staleWhileFetching: s } = oldVal;
          if (s !== void 0 && !noDisposeOnSet) {
            if (this.#hasDispose) {
              this.#dispose?.(s, k, "set");
            }
            if (this.#hasDisposeAfter) {
              this.#disposed?.push([s, k, "set"]);
            }
          }
        } else if (!noDisposeOnSet) {
          if (this.#hasDispose) {
            this.#dispose?.(oldVal, k, "set");
          }
          if (this.#hasDisposeAfter) {
            this.#disposed?.push([oldVal, k, "set"]);
          }
        }
        this.#removeItemSize(index);
        this.#addItemSize(index, size, status);
        this.#valList[index] = v;
        if (status) {
          status.set = "replace";
          const oldValue = oldVal && this.#isBackgroundFetch(oldVal) ? oldVal.__staleWhileFetching : oldVal;
          if (oldValue !== void 0)
            status.oldValue = oldValue;
        }
      } else if (status) {
        status.set = "update";
      }
    }
    if (ttl !== 0 && !this.#ttls) {
      this.#initializeTTLTracking();
    }
    if (this.#ttls) {
      if (!noUpdateTTL) {
        this.#setItemTTL(index, ttl, start);
      }
      if (status)
        this.#statusTTL(status, index);
    }
    if (!noDisposeOnSet && this.#hasDisposeAfter && this.#disposed) {
      const dt = this.#disposed;
      let task;
      while (task = dt?.shift()) {
        this.#disposeAfter?.(...task);
      }
    }
    return this;
  }
  /**
   * Evict the least recently used item, returning its value or
   * `undefined` if cache is empty.
   */
  pop() {
    try {
      while (this.#size) {
        const val = this.#valList[this.#head];
        this.#evict(true);
        if (this.#isBackgroundFetch(val)) {
          if (val.__staleWhileFetching) {
            return val.__staleWhileFetching;
          }
        } else if (val !== void 0) {
          return val;
        }
      }
    } finally {
      if (this.#hasDisposeAfter && this.#disposed) {
        const dt = this.#disposed;
        let task;
        while (task = dt?.shift()) {
          this.#disposeAfter?.(...task);
        }
      }
    }
  }
  #evict(free) {
    const head = this.#head;
    const k = this.#keyList[head];
    const v = this.#valList[head];
    if (this.#hasFetchMethod && this.#isBackgroundFetch(v)) {
      v.__abortController.abort(new Error("evicted"));
    } else if (this.#hasDispose || this.#hasDisposeAfter) {
      if (this.#hasDispose) {
        this.#dispose?.(v, k, "evict");
      }
      if (this.#hasDisposeAfter) {
        this.#disposed?.push([v, k, "evict"]);
      }
    }
    this.#removeItemSize(head);
    if (free) {
      this.#keyList[head] = void 0;
      this.#valList[head] = void 0;
      this.#free.push(head);
    }
    if (this.#size === 1) {
      this.#head = this.#tail = 0;
      this.#free.length = 0;
    } else {
      this.#head = this.#next[head];
    }
    this.#keyMap.delete(k);
    this.#size--;
    return head;
  }
  /**
   * Check if a key is in the cache, without updating the recency of use.
   * Will return false if the item is stale, even though it is technically
   * in the cache.
   *
   * Check if a key is in the cache, without updating the recency of
   * use. Age is updated if {@link LRUCache.OptionsBase.updateAgeOnHas} is set
   * to `true` in either the options or the constructor.
   *
   * Will return `false` if the item is stale, even though it is technically in
   * the cache. The difference can be determined (if it matters) by using a
   * `status` argument, and inspecting the `has` field.
   *
   * Will not update item age unless
   * {@link LRUCache.OptionsBase.updateAgeOnHas} is set.
   */
  has(k, hasOptions = {}) {
    const { updateAgeOnHas = this.updateAgeOnHas, status } = hasOptions;
    const index = this.#keyMap.get(k);
    if (index !== void 0) {
      const v = this.#valList[index];
      if (this.#isBackgroundFetch(v) && v.__staleWhileFetching === void 0) {
        return false;
      }
      if (!this.#isStale(index)) {
        if (updateAgeOnHas) {
          this.#updateItemAge(index);
        }
        if (status) {
          status.has = "hit";
          this.#statusTTL(status, index);
        }
        return true;
      } else if (status) {
        status.has = "stale";
        this.#statusTTL(status, index);
      }
    } else if (status) {
      status.has = "miss";
    }
    return false;
  }
  /**
   * Like {@link LRUCache#get} but doesn't update recency or delete stale
   * items.
   *
   * Returns `undefined` if the item is stale, unless
   * {@link LRUCache.OptionsBase.allowStale} is set.
   */
  peek(k, peekOptions = {}) {
    const { allowStale = this.allowStale } = peekOptions;
    const index = this.#keyMap.get(k);
    if (index === void 0 || !allowStale && this.#isStale(index)) {
      return;
    }
    const v = this.#valList[index];
    return this.#isBackgroundFetch(v) ? v.__staleWhileFetching : v;
  }
  #backgroundFetch(k, index, options, context) {
    const v = index === void 0 ? void 0 : this.#valList[index];
    if (this.#isBackgroundFetch(v)) {
      return v;
    }
    const ac = new AC$1();
    const { signal } = options;
    signal?.addEventListener("abort", () => ac.abort(signal.reason), {
      signal: ac.signal
    });
    const fetchOpts = {
      signal: ac.signal,
      options,
      context
    };
    const cb = (v2, updateCache = false) => {
      const { aborted } = ac.signal;
      const ignoreAbort = options.ignoreFetchAbort && v2 !== void 0;
      if (options.status) {
        if (aborted && !updateCache) {
          options.status.fetchAborted = true;
          options.status.fetchError = ac.signal.reason;
          if (ignoreAbort)
            options.status.fetchAbortIgnored = true;
        } else {
          options.status.fetchResolved = true;
        }
      }
      if (aborted && !ignoreAbort && !updateCache) {
        return fetchFail(ac.signal.reason);
      }
      const bf2 = p;
      if (this.#valList[index] === p) {
        if (v2 === void 0) {
          if (bf2.__staleWhileFetching) {
            this.#valList[index] = bf2.__staleWhileFetching;
          } else {
            this.#delete(k, "fetch");
          }
        } else {
          if (options.status)
            options.status.fetchUpdated = true;
          this.set(k, v2, fetchOpts.options);
        }
      }
      return v2;
    };
    const eb = (er) => {
      if (options.status) {
        options.status.fetchRejected = true;
        options.status.fetchError = er;
      }
      return fetchFail(er);
    };
    const fetchFail = (er) => {
      const { aborted } = ac.signal;
      const allowStaleAborted = aborted && options.allowStaleOnFetchAbort;
      const allowStale = allowStaleAborted || options.allowStaleOnFetchRejection;
      const noDelete = allowStale || options.noDeleteOnFetchRejection;
      const bf2 = p;
      if (this.#valList[index] === p) {
        const del = !noDelete || bf2.__staleWhileFetching === void 0;
        if (del) {
          this.#delete(k, "fetch");
        } else if (!allowStaleAborted) {
          this.#valList[index] = bf2.__staleWhileFetching;
        }
      }
      if (allowStale) {
        if (options.status && bf2.__staleWhileFetching !== void 0) {
          options.status.returnedStale = true;
        }
        return bf2.__staleWhileFetching;
      } else if (bf2.__returned === bf2) {
        throw er;
      }
    };
    const pcall = (res, rej) => {
      const fmp = this.#fetchMethod?.(k, v, fetchOpts);
      if (fmp && fmp instanceof Promise) {
        fmp.then((v2) => res(v2 === void 0 ? void 0 : v2), rej);
      }
      ac.signal.addEventListener("abort", () => {
        if (!options.ignoreFetchAbort || options.allowStaleOnFetchAbort) {
          res(void 0);
          if (options.allowStaleOnFetchAbort) {
            res = (v2) => cb(v2, true);
          }
        }
      });
    };
    if (options.status)
      options.status.fetchDispatched = true;
    const p = new Promise(pcall).then(cb, eb);
    const bf = Object.assign(p, {
      __abortController: ac,
      __staleWhileFetching: v,
      __returned: void 0
    });
    if (index === void 0) {
      this.set(k, bf, { ...fetchOpts.options, status: void 0 });
      index = this.#keyMap.get(k);
    } else {
      this.#valList[index] = bf;
    }
    return bf;
  }
  #isBackgroundFetch(p) {
    if (!this.#hasFetchMethod)
      return false;
    const b = p;
    return !!b && b instanceof Promise && b.hasOwnProperty("__staleWhileFetching") && b.__abortController instanceof AC$1;
  }
  async fetch(k, fetchOptions = {}) {
    const {
      // get options
      allowStale = this.allowStale,
      updateAgeOnGet = this.updateAgeOnGet,
      noDeleteOnStaleGet = this.noDeleteOnStaleGet,
      // set options
      ttl = this.ttl,
      noDisposeOnSet = this.noDisposeOnSet,
      size = 0,
      sizeCalculation = this.sizeCalculation,
      noUpdateTTL = this.noUpdateTTL,
      // fetch exclusive options
      noDeleteOnFetchRejection = this.noDeleteOnFetchRejection,
      allowStaleOnFetchRejection = this.allowStaleOnFetchRejection,
      ignoreFetchAbort = this.ignoreFetchAbort,
      allowStaleOnFetchAbort = this.allowStaleOnFetchAbort,
      context,
      forceRefresh = false,
      status,
      signal
    } = fetchOptions;
    if (!this.#hasFetchMethod) {
      if (status)
        status.fetch = "get";
      return this.get(k, {
        allowStale,
        updateAgeOnGet,
        noDeleteOnStaleGet,
        status
      });
    }
    const options = {
      allowStale,
      updateAgeOnGet,
      noDeleteOnStaleGet,
      ttl,
      noDisposeOnSet,
      size,
      sizeCalculation,
      noUpdateTTL,
      noDeleteOnFetchRejection,
      allowStaleOnFetchRejection,
      allowStaleOnFetchAbort,
      ignoreFetchAbort,
      status,
      signal
    };
    let index = this.#keyMap.get(k);
    if (index === void 0) {
      if (status)
        status.fetch = "miss";
      const p = this.#backgroundFetch(k, index, options, context);
      return p.__returned = p;
    } else {
      const v = this.#valList[index];
      if (this.#isBackgroundFetch(v)) {
        const stale = allowStale && v.__staleWhileFetching !== void 0;
        if (status) {
          status.fetch = "inflight";
          if (stale)
            status.returnedStale = true;
        }
        return stale ? v.__staleWhileFetching : v.__returned = v;
      }
      const isStale = this.#isStale(index);
      if (!forceRefresh && !isStale) {
        if (status)
          status.fetch = "hit";
        this.#moveToTail(index);
        if (updateAgeOnGet) {
          this.#updateItemAge(index);
        }
        if (status)
          this.#statusTTL(status, index);
        return v;
      }
      const p = this.#backgroundFetch(k, index, options, context);
      const hasStale = p.__staleWhileFetching !== void 0;
      const staleVal = hasStale && allowStale;
      if (status) {
        status.fetch = isStale ? "stale" : "refresh";
        if (staleVal && isStale)
          status.returnedStale = true;
      }
      return staleVal ? p.__staleWhileFetching : p.__returned = p;
    }
  }
  async forceFetch(k, fetchOptions = {}) {
    const v = await this.fetch(k, fetchOptions);
    if (v === void 0)
      throw new Error("fetch() returned undefined");
    return v;
  }
  memo(k, memoOptions = {}) {
    const memoMethod = this.#memoMethod;
    if (!memoMethod) {
      throw new Error("no memoMethod provided to constructor");
    }
    const { context, forceRefresh, ...options } = memoOptions;
    const v = this.get(k, options);
    if (!forceRefresh && v !== void 0)
      return v;
    const vv = memoMethod(k, v, {
      options,
      context
    });
    this.set(k, vv, options);
    return vv;
  }
  /**
   * Return a value from the cache. Will update the recency of the cache
   * entry found.
   *
   * If the key is not found, get() will return `undefined`.
   */
  get(k, getOptions = {}) {
    const { allowStale = this.allowStale, updateAgeOnGet = this.updateAgeOnGet, noDeleteOnStaleGet = this.noDeleteOnStaleGet, status } = getOptions;
    const index = this.#keyMap.get(k);
    if (index !== void 0) {
      const value = this.#valList[index];
      const fetching = this.#isBackgroundFetch(value);
      if (status)
        this.#statusTTL(status, index);
      if (this.#isStale(index)) {
        if (status)
          status.get = "stale";
        if (!fetching) {
          if (!noDeleteOnStaleGet) {
            this.#delete(k, "expire");
          }
          if (status && allowStale)
            status.returnedStale = true;
          return allowStale ? value : void 0;
        } else {
          if (status && allowStale && value.__staleWhileFetching !== void 0) {
            status.returnedStale = true;
          }
          return allowStale ? value.__staleWhileFetching : void 0;
        }
      } else {
        if (status)
          status.get = "hit";
        if (fetching) {
          return value.__staleWhileFetching;
        }
        this.#moveToTail(index);
        if (updateAgeOnGet) {
          this.#updateItemAge(index);
        }
        return value;
      }
    } else if (status) {
      status.get = "miss";
    }
  }
  #connect(p, n) {
    this.#prev[n] = p;
    this.#next[p] = n;
  }
  #moveToTail(index) {
    if (index !== this.#tail) {
      if (index === this.#head) {
        this.#head = this.#next[index];
      } else {
        this.#connect(this.#prev[index], this.#next[index]);
      }
      this.#connect(this.#tail, index);
      this.#tail = index;
    }
  }
  /**
   * Deletes a key out of the cache.
   *
   * Returns true if the key was deleted, false otherwise.
   */
  delete(k) {
    return this.#delete(k, "delete");
  }
  #delete(k, reason) {
    let deleted = false;
    if (this.#size !== 0) {
      const index = this.#keyMap.get(k);
      if (index !== void 0) {
        deleted = true;
        if (this.#size === 1) {
          this.#clear(reason);
        } else {
          this.#removeItemSize(index);
          const v = this.#valList[index];
          if (this.#isBackgroundFetch(v)) {
            v.__abortController.abort(new Error("deleted"));
          } else if (this.#hasDispose || this.#hasDisposeAfter) {
            if (this.#hasDispose) {
              this.#dispose?.(v, k, reason);
            }
            if (this.#hasDisposeAfter) {
              this.#disposed?.push([v, k, reason]);
            }
          }
          this.#keyMap.delete(k);
          this.#keyList[index] = void 0;
          this.#valList[index] = void 0;
          if (index === this.#tail) {
            this.#tail = this.#prev[index];
          } else if (index === this.#head) {
            this.#head = this.#next[index];
          } else {
            const pi = this.#prev[index];
            this.#next[pi] = this.#next[index];
            const ni = this.#next[index];
            this.#prev[ni] = this.#prev[index];
          }
          this.#size--;
          this.#free.push(index);
        }
      }
    }
    if (this.#hasDisposeAfter && this.#disposed?.length) {
      const dt = this.#disposed;
      let task;
      while (task = dt?.shift()) {
        this.#disposeAfter?.(...task);
      }
    }
    return deleted;
  }
  /**
   * Clear the cache entirely, throwing away all values.
   */
  clear() {
    return this.#clear("delete");
  }
  #clear(reason) {
    for (const index of this.#rindexes({ allowStale: true })) {
      const v = this.#valList[index];
      if (this.#isBackgroundFetch(v)) {
        v.__abortController.abort(new Error("deleted"));
      } else {
        const k = this.#keyList[index];
        if (this.#hasDispose) {
          this.#dispose?.(v, k, reason);
        }
        if (this.#hasDisposeAfter) {
          this.#disposed?.push([v, k, reason]);
        }
      }
    }
    this.#keyMap.clear();
    this.#valList.fill(void 0);
    this.#keyList.fill(void 0);
    if (this.#ttls && this.#starts) {
      this.#ttls.fill(0);
      this.#starts.fill(0);
    }
    if (this.#sizes) {
      this.#sizes.fill(0);
    }
    this.#head = 0;
    this.#tail = 0;
    this.#free.length = 0;
    this.#calculatedSize = 0;
    this.#size = 0;
    if (this.#hasDisposeAfter && this.#disposed) {
      const dt = this.#disposed;
      let task;
      while (task = dt?.shift()) {
        this.#disposeAfter?.(...task);
      }
    }
  }
};
var cjs$1;
var hasRequiredCjs$1;
function requireCjs$1() {
  if (hasRequiredCjs$1) return cjs$1;
  hasRequiredCjs$1 = 1;
  var isMergeableObject = function isMergeableObject2(value) {
    return isNonNullObject(value) && !isSpecial(value);
  };
  function isNonNullObject(value) {
    return !!value && typeof value === "object";
  }
  function isSpecial(value) {
    var stringValue = Object.prototype.toString.call(value);
    return stringValue === "[object RegExp]" || stringValue === "[object Date]" || isReactElement(value);
  }
  var canUseSymbol = typeof Symbol === "function" && Symbol.for;
  var REACT_ELEMENT_TYPE = canUseSymbol ? /* @__PURE__ */ Symbol.for("react.element") : 60103;
  function isReactElement(value) {
    return value.$$typeof === REACT_ELEMENT_TYPE;
  }
  function emptyTarget(val) {
    return Array.isArray(val) ? [] : {};
  }
  function cloneUnlessOtherwiseSpecified(value, options) {
    return options.clone !== false && options.isMergeableObject(value) ? deepmerge2(emptyTarget(value), value, options) : value;
  }
  function defaultArrayMerge(target, source, options) {
    return target.concat(source).map(function(element) {
      return cloneUnlessOtherwiseSpecified(element, options);
    });
  }
  function getMergeFunction(key, options) {
    if (!options.customMerge) {
      return deepmerge2;
    }
    var customMerge = options.customMerge(key);
    return typeof customMerge === "function" ? customMerge : deepmerge2;
  }
  function getEnumerableOwnPropertySymbols(target) {
    return Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(target).filter(function(symbol) {
      return Object.propertyIsEnumerable.call(target, symbol);
    }) : [];
  }
  function getKeys(target) {
    return Object.keys(target).concat(getEnumerableOwnPropertySymbols(target));
  }
  function propertyIsOnObject(object, property) {
    try {
      return property in object;
    } catch (_) {
      return false;
    }
  }
  function propertyIsUnsafe(target, key) {
    return propertyIsOnObject(target, key) && !(Object.hasOwnProperty.call(target, key) && Object.propertyIsEnumerable.call(target, key));
  }
  function mergeObject2(target, source, options) {
    var destination = {};
    if (options.isMergeableObject(target)) {
      getKeys(target).forEach(function(key) {
        destination[key] = cloneUnlessOtherwiseSpecified(target[key], options);
      });
    }
    getKeys(source).forEach(function(key) {
      if (propertyIsUnsafe(target, key)) {
        return;
      }
      if (propertyIsOnObject(target, key) && options.isMergeableObject(source[key])) {
        destination[key] = getMergeFunction(key, options)(target[key], source[key], options);
      } else {
        destination[key] = cloneUnlessOtherwiseSpecified(source[key], options);
      }
    });
    return destination;
  }
  function deepmerge2(target, source, options) {
    options = options || {};
    options.arrayMerge = options.arrayMerge || defaultArrayMerge;
    options.isMergeableObject = options.isMergeableObject || isMergeableObject;
    options.cloneUnlessOtherwiseSpecified = cloneUnlessOtherwiseSpecified;
    var sourceIsArray = Array.isArray(source);
    var targetIsArray = Array.isArray(target);
    var sourceAndTargetTypesMatch = sourceIsArray === targetIsArray;
    if (!sourceAndTargetTypesMatch) {
      return cloneUnlessOtherwiseSpecified(source, options);
    } else if (sourceIsArray) {
      return options.arrayMerge(target, source, options);
    } else {
      return mergeObject2(target, source, options);
    }
  }
  deepmerge2.all = function deepmergeAll(array, options) {
    if (!Array.isArray(array)) {
      throw new Error("first argument should be an array");
    }
    return array.reduce(function(prev, next) {
      return deepmerge2(prev, next, options);
    }, {});
  };
  var deepmerge_1 = deepmerge2;
  cjs$1 = deepmerge_1;
  return cjs$1;
}
var cjsExports = requireCjs$1();
const deepmerge$2 = /* @__PURE__ */ getDefaultExportFromCjs$1(cjsExports);
var localClassNames$1 = /* @__PURE__ */ new Set();
var composedClassLists$1 = [];
var bufferedCSSObjs$1 = [];
var browserRuntimeAdapter$1 = {
  appendCss: (cssObj) => {
    bufferedCSSObjs$1.push(cssObj);
  },
  registerClassName: (className) => {
    localClassNames$1.add(className);
  },
  registerComposition: (composition) => {
    composedClassLists$1.push(composition);
  },
  markCompositionUsed: () => {
  },
  onEndFileScope: (fileScope) => {
    var css2 = transformCss$1({
      localClassNames: Array.from(localClassNames$1),
      composedClassLists: composedClassLists$1,
      cssObjs: bufferedCSSObjs$1
    }).join("\n");
    injectStyles$1({
      fileScope,
      css: css2
    });
    bufferedCSSObjs$1 = [];
  },
  getIdentOption: () => process.env.NODE_ENV === "production" ? "short" : "debug"
};
{
  setAdapterIfNotSet$1(browserRuntimeAdapter$1);
}
var getLastSlashBeforeIndex$1 = (path, index) => {
  var pathIndex = index - 1;
  while (pathIndex >= 0) {
    if (path[pathIndex] === "/") {
      return pathIndex;
    }
    pathIndex--;
  }
  return -1;
};
var _getDebugFileName$1 = (path) => {
  var file;
  var lastIndexOfDotCss = path.lastIndexOf(".css");
  if (lastIndexOfDotCss === -1) {
    return "";
  }
  var lastSlashIndex = getLastSlashBeforeIndex$1(path, lastIndexOfDotCss);
  file = path.slice(lastSlashIndex + 1, lastIndexOfDotCss);
  if (lastSlashIndex === -1) {
    return file;
  }
  var secondLastSlashIndex = getLastSlashBeforeIndex$1(path, lastSlashIndex - 1);
  var dir = path.slice(secondLastSlashIndex + 1, lastSlashIndex);
  var debugFileName = file !== "index" ? file : dir;
  return debugFileName;
};
var memoizedGetDebugFileName$1 = () => {
  var cache = new LRUCache$1({
    max: 500
  });
  return (path) => {
    var cachedResult = cache.get(path);
    if (cachedResult) {
      return cachedResult;
    }
    var result = _getDebugFileName$1(path);
    cache.set(path, result);
    return result;
  };
};
var getDebugFileName$1 = memoizedGetDebugFileName$1();
function getDevPrefix$1(_ref) {
  var {
    debugId,
    debugFileName
  } = _ref;
  var parts = debugId ? [debugId.replace(/\s/g, "_")] : [];
  if (debugFileName) {
    var {
      filePath
    } = getFileScope$1();
    var _debugFileName = getDebugFileName$1(filePath);
    if (_debugFileName) {
      parts.unshift(_debugFileName);
    }
  }
  return parts.join("_");
}
function normalizeIdentifier$1(identifier) {
  return identifier.match(/^[0-9]/) ? "_".concat(identifier) : identifier;
}
function generateIdentifier$1(arg) {
  var identOption = getIdentOption$1();
  var {
    debugId,
    debugFileName = true
  } = _objectSpread2$1(_objectSpread2$1({}, typeof arg === "string" ? {
    debugId: arg
  } : null), typeof arg === "object" ? arg : null);
  var refCount = getAndIncrementRefCounter$1().toString(36);
  var {
    filePath,
    packageName
  } = getFileScope$1();
  var fileScopeHash = murmur2$1(packageName ? "".concat(packageName).concat(filePath) : filePath);
  var identifier = "".concat(fileScopeHash).concat(refCount);
  if (identOption === "debug") {
    var devPrefix = getDevPrefix$1({
      debugId,
      debugFileName
    });
    if (devPrefix) {
      identifier = "".concat(devPrefix, "__").concat(identifier);
    }
    return normalizeIdentifier$1(identifier);
  }
  if (typeof identOption === "function") {
    identifier = identOption({
      hash: identifier,
      debugId,
      filePath,
      packageName
    });
    if (!identifier.match(/^[A-Z_][0-9A-Z_-]+$/i)) {
      throw new Error('Identifier function returned invalid indentifier: "'.concat(identifier, '"'));
    }
    return identifier;
  }
  return normalizeIdentifier$1(identifier);
}
var buildPropertyRule = (_ref) => {
  var {
    syntax,
    inherits,
    initialValue
  } = _ref;
  return _objectSpread2$1({
    syntax: '"'.concat(Array.isArray(syntax) ? syntax.join(" | ") : syntax, '"'),
    inherits: inherits ? "true" : "false"
  }, initialValue != null ? {
    initialValue
  } : {});
};
function createVar(debugIdOrDeclaration, debugId) {
  var cssVarName = cssesc$1(generateIdentifier$1({
    debugId: typeof debugIdOrDeclaration === "string" ? debugIdOrDeclaration : debugId,
    debugFileName: false
  }), {
    isIdentifier: true
  });
  if (debugIdOrDeclaration && typeof debugIdOrDeclaration === "object") {
    appendCss$1({
      type: "property",
      name: "--".concat(cssVarName),
      rule: buildPropertyRule(debugIdOrDeclaration)
    }, getFileScope$1());
  }
  return "var(--".concat(cssVarName, ")");
}
function assertVarName(value) {
  if (typeof value !== "string" || !/^var\(--.*\)$/.test(value)) {
    throw new Error("Invalid variable name: ".concat(value));
  }
}
function fallbackVar() {
  var finalValue = "";
  for (var _len = arguments.length, values = new Array(_len), _key = 0; _key < _len; _key++) {
    values[_key] = arguments[_key];
  }
  values.reverse().forEach((value) => {
    if (finalValue === "") {
      finalValue = String(value);
    } else {
      assertVarName(value);
      finalValue = value.replace(/\)$/, ", ".concat(finalValue, ")"));
    }
  });
  return finalValue;
}
function composedStyle(rules, debugId) {
  var className = generateIdentifier$1(debugId);
  registerClassName(className, getFileScope$1());
  var classList = [];
  var styleRules = [];
  for (var rule of rules) {
    if (typeof rule === "string") {
      classList.push(rule);
    } else {
      styleRules.push(rule);
    }
  }
  var result = className;
  if (classList.length > 0) {
    result = "".concat(className, " ").concat(dudupeAndJoinClassList(classList));
    registerComposition({
      identifier: className,
      classList: result
    }, getFileScope$1());
    if (styleRules.length > 0) {
      markCompositionUsed$1(className);
    }
  }
  if (styleRules.length > 0) {
    var _rule = deepmerge$2.all(styleRules, {
      // Replace arrays rather than merging
      arrayMerge: (_, sourceArray) => sourceArray
    });
    appendCss$1({
      type: "local",
      selector: className,
      rule: _rule
    }, getFileScope$1());
  }
  return result;
}
function style(rule, debugId) {
  if (Array.isArray(rule)) {
    return composedStyle(rule, debugId);
  }
  var className = generateIdentifier$1(debugId);
  registerClassName(className, getFileScope$1());
  appendCss$1({
    type: "local",
    selector: className,
    rule
  }, getFileScope$1());
  return className;
}
function globalStyle(selector, rule) {
  appendCss$1({
    type: "global",
    selector,
    rule
  }, getFileScope$1());
}
var deepmerge$1 = { exports: {} };
var hasRequiredDeepmerge;
function requireDeepmerge() {
  if (hasRequiredDeepmerge) return deepmerge$1.exports;
  hasRequiredDeepmerge = 1;
  (function(module) {
    const JSON_PROTO = Object.getPrototypeOf({});
    function defaultIsMergeableObjectFactory() {
      return function defaultIsMergeableObject(value) {
        return typeof value === "object" && value !== null && !(value instanceof RegExp) && !(value instanceof Date);
      };
    }
    function deepmergeConstructor(options) {
      function isNotPrototypeKey(value) {
        return value !== "constructor" && value !== "prototype" && value !== "__proto__";
      }
      function cloneArray(value) {
        let i = 0;
        const il = value.length;
        const result = new Array(il);
        for (i; i < il; ++i) {
          result[i] = clone(value[i]);
        }
        return result;
      }
      function cloneObject(target) {
        const result = {};
        if (cloneProtoObject && Object.getPrototypeOf(target) !== JSON_PROTO) {
          return cloneProtoObject(target);
        }
        const targetKeys = getKeys(target);
        let i, il, key;
        for (i = 0, il = targetKeys.length; i < il; ++i) {
          isNotPrototypeKey(key = targetKeys[i]) && (result[key] = clone(target[key]));
        }
        return result;
      }
      function concatArrays(target, source) {
        const tl = target.length;
        const sl = source.length;
        let i = 0;
        const result = new Array(tl + sl);
        for (i; i < tl; ++i) {
          result[i] = clone(target[i]);
        }
        for (i = 0; i < sl; ++i) {
          result[i + tl] = clone(source[i]);
        }
        return result;
      }
      const propertyIsEnumerable = Object.prototype.propertyIsEnumerable;
      function getSymbolsAndKeys(value) {
        const result = Object.keys(value);
        const keys = Object.getOwnPropertySymbols(value);
        for (let i = 0, il = keys.length; i < il; ++i) {
          propertyIsEnumerable.call(value, keys[i]) && result.push(keys[i]);
        }
        return result;
      }
      const getKeys = options?.symbols ? getSymbolsAndKeys : Object.keys;
      const cloneProtoObject = typeof options?.cloneProtoObject === "function" ? options.cloneProtoObject : void 0;
      const isMergeableObject = typeof options?.isMergeableObject === "function" ? options.isMergeableObject : defaultIsMergeableObjectFactory();
      function isPrimitive(value) {
        return typeof value !== "object" || value === null;
      }
      const mergeArray = options && typeof options.mergeArray === "function" ? options.mergeArray({ clone, deepmerge: _deepmerge, getKeys, isMergeableObject }) : concatArrays;
      function clone(entry) {
        return isMergeableObject(entry) ? Array.isArray(entry) ? cloneArray(entry) : cloneObject(entry) : entry;
      }
      function mergeObject2(target, source) {
        const result = {};
        const targetKeys = getKeys(target);
        const sourceKeys = getKeys(source);
        let i, il, key;
        for (i = 0, il = targetKeys.length; i < il; ++i) {
          isNotPrototypeKey(key = targetKeys[i]) && sourceKeys.indexOf(key) === -1 && (result[key] = clone(target[key]));
        }
        for (i = 0, il = sourceKeys.length; i < il; ++i) {
          if (!isNotPrototypeKey(key = sourceKeys[i])) {
            continue;
          }
          if (key in target) {
            if (targetKeys.indexOf(key) !== -1) {
              if (cloneProtoObject && isMergeableObject(source[key]) && Object.getPrototypeOf(source[key]) !== JSON_PROTO) {
                result[key] = cloneProtoObject(source[key]);
              } else {
                result[key] = _deepmerge(target[key], source[key]);
              }
            }
          } else {
            result[key] = clone(source[key]);
          }
        }
        return result;
      }
      function _deepmerge(target, source) {
        const sourceIsArray = Array.isArray(source);
        const targetIsArray = Array.isArray(target);
        if (isPrimitive(source)) {
          return source;
        } else if (!isMergeableObject(target)) {
          return clone(source);
        } else if (sourceIsArray && targetIsArray) {
          return mergeArray(target, source);
        } else if (sourceIsArray !== targetIsArray) {
          return clone(source);
        } else {
          return mergeObject2(target, source);
        }
      }
      function _deepmergeAll() {
        switch (arguments.length) {
          case 0:
            return {};
          case 1:
            return clone(arguments[0]);
          case 2:
            return _deepmerge(arguments[0], arguments[1]);
        }
        let result;
        for (let i = 0, il = arguments.length; i < il; ++i) {
          result = _deepmerge(result, arguments[i]);
        }
        return result;
      }
      return options?.all ? _deepmergeAll : _deepmerge;
    }
    module.exports = deepmergeConstructor;
    module.exports.default = deepmergeConstructor;
    module.exports.deepmerge = deepmergeConstructor;
    Object.defineProperty(module.exports, "isMergeableObject", {
      get: defaultIsMergeableObjectFactory
    });
  })(deepmerge$1);
  return deepmerge$1.exports;
}
var deepmergeExports = requireDeepmerge();
const deepmerge = /* @__PURE__ */ getDefaultExportFromCjs$1(deepmergeExports);
var __defProp = Object.defineProperty;
var __typeError = (msg) => {
  throw TypeError(msg);
};
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
var __accessCheck = (obj, member, msg) => member.has(obj) || __typeError("Cannot " + msg);
var __privateGet = (obj, member, getter) => (__accessCheck(obj, member, "read from private field"), getter ? getter.call(obj) : member.get(obj));
var __privateAdd = (obj, member, value) => member.has(obj) ? __typeError("Cannot add the same private member more than once") : member instanceof WeakSet ? member.add(obj) : member.set(obj, value);
var __privateSet = (obj, member, value, setter) => (__accessCheck(obj, member, "write to private field"), member.set(obj, value), value);
var __privateMethod = (obj, member, method) => (__accessCheck(obj, member, "access private method"), method);
var __privateWrapper = (obj, member, setter, getter) => ({
  set _(value) {
    __privateSet(obj, member, value);
  },
  get _() {
    return __privateGet(obj, member, getter);
  }
});
var _constructing, _a, _b, _max, _maxSize, _dispose, _disposeAfter, _fetchMethod, _memoMethod, _size, _calculatedSize, _keyMap, _keyList, _valList, _next, _prev, _head, _tail, _free, _disposed, _sizes, _starts, _ttls, _hasDispose, _hasFetchMethod, _hasDisposeAfter, _LRUCache_instances, initializeTTLTracking_fn, _updateItemAge, _statusTTL, _setItemTTL, _isStale, initializeSizeTracking_fn, _removeItemSize, _addItemSize, _requireSize, indexes_fn, rindexes_fn, isValidIndex_fn, evict_fn, backgroundFetch_fn, isBackgroundFetch_fn, connect_fn, moveToTail_fn, delete_fn, clear_fn;
var stylesheets = {};
var injectStyles = (_ref) => {
  var {
    fileScope,
    css: css2
  } = _ref;
  var fileScopeId = fileScope.packageName ? [fileScope.packageName, fileScope.filePath].join("/") : fileScope.filePath;
  var stylesheet = stylesheets[fileScopeId];
  if (!stylesheet) {
    var styleEl = document.createElement("style");
    if (fileScope.packageName) {
      styleEl.setAttribute("data-package", fileScope.packageName);
    }
    styleEl.setAttribute("data-file", fileScope.filePath);
    styleEl.setAttribute("type", "text/css");
    stylesheet = stylesheets[fileScopeId] = styleEl;
    document.head.appendChild(styleEl);
  }
  stylesheet.innerHTML = css2;
};
function getVarName$1(variable) {
  var matches = variable.match(/^var\((.*)\)$/);
  if (matches) {
    return matches[1];
  }
  return variable;
}
function getDefaultExportFromCjs(x) {
  return x && x.__esModule && Object.prototype.hasOwnProperty.call(x, "default") ? x["default"] : x;
}
var cssesc_1;
var hasRequiredCssesc;
function requireCssesc() {
  if (hasRequiredCssesc) return cssesc_1;
  hasRequiredCssesc = 1;
  var object = {};
  var hasOwnProperty = object.hasOwnProperty;
  var merge = function merge2(options, defaults) {
    if (!options) {
      return defaults;
    }
    var result = {};
    for (var key in defaults) {
      result[key] = hasOwnProperty.call(options, key) ? options[key] : defaults[key];
    }
    return result;
  };
  var regexAnySingleEscape = /[ -,\.\/:-@\[-\^`\{-~]/;
  var regexSingleEscape = /[ -,\.\/:-@\[\]\^`\{-~]/;
  var regexExcessiveSpaces = /(^|\\+)?(\\[A-F0-9]{1,6})\x20(?![a-fA-F0-9\x20])/g;
  var cssesc2 = function cssesc3(string, options) {
    options = merge(options, cssesc3.options);
    if (options.quotes != "single" && options.quotes != "double") {
      options.quotes = "single";
    }
    var quote = options.quotes == "double" ? '"' : "'";
    var isIdentifier = options.isIdentifier;
    var firstChar = string.charAt(0);
    var output = "";
    var counter = 0;
    var length = string.length;
    while (counter < length) {
      var character = string.charAt(counter++);
      var codePoint = character.charCodeAt();
      var value = void 0;
      if (codePoint < 32 || codePoint > 126) {
        if (codePoint >= 55296 && codePoint <= 56319 && counter < length) {
          var extra = string.charCodeAt(counter++);
          if ((extra & 64512) == 56320) {
            codePoint = ((codePoint & 1023) << 10) + (extra & 1023) + 65536;
          } else {
            counter--;
          }
        }
        value = "\\" + codePoint.toString(16).toUpperCase() + " ";
      } else {
        if (options.escapeEverything) {
          if (regexAnySingleEscape.test(character)) {
            value = "\\" + character;
          } else {
            value = "\\" + codePoint.toString(16).toUpperCase() + " ";
          }
        } else if (/[\t\n\f\r\x0B]/.test(character)) {
          value = "\\" + codePoint.toString(16).toUpperCase() + " ";
        } else if (character == "\\" || !isIdentifier && (character == '"' && quote == character || character == "'" && quote == character) || isIdentifier && regexSingleEscape.test(character)) {
          value = "\\" + character;
        } else {
          value = character;
        }
      }
      output += value;
    }
    if (isIdentifier) {
      if (/^-[-\d]/.test(output)) {
        output = "\\-" + output.slice(1);
      } else if (/\d/.test(firstChar)) {
        output = "\\3" + firstChar + " " + output.slice(1);
      }
    }
    output = output.replace(regexExcessiveSpaces, function($0, $1, $2) {
      if ($1 && $1.length % 2) {
        return $0;
      }
      return ($1 || "") + $2;
    });
    if (!isIdentifier && options.wrap) {
      return quote + output + quote;
    }
    return output;
  };
  cssesc2.options = {
    "escapeEverything": false,
    "isIdentifier": false,
    "quotes": "single",
    "wrap": false
  };
  cssesc2.version = "3.0.0";
  cssesc_1 = cssesc2;
  return cssesc_1;
}
var cssescExports = requireCssesc();
const cssesc = /* @__PURE__ */ getDefaultExportFromCjs(cssescExports);
class AhoCorasick2 {
  constructor(keywords) {
    const { failure, gotoFn, output } = this._buildTables(keywords);
    this.gotoFn = gotoFn;
    this.output = output;
    this.failure = failure;
  }
  _buildTables(keywords) {
    const gotoFn = {
      0: {}
    };
    const output = {};
    let state = 0;
    for (const word of keywords) {
      let curr = 0;
      for (const l of word) {
        if (gotoFn[curr] && l in gotoFn[curr]) {
          curr = gotoFn[curr][l];
        } else {
          state++;
          gotoFn[curr][l] = state;
          gotoFn[state] = {};
          curr = state;
          output[state] = [];
        }
      }
      output[curr].push(word);
    }
    const failure = {};
    const xs = [];
    for (const l in gotoFn[0]) {
      const state2 = gotoFn[0][l];
      failure[state2] = 0;
      xs.push(state2);
    }
    while (xs.length > 0) {
      const r2 = xs.shift();
      if (r2 !== void 0) {
        for (const l in gotoFn[r2]) {
          const s = gotoFn[r2][l];
          xs.push(s);
          let state2 = failure[r2];
          while (state2 > 0 && !(l in gotoFn[state2])) {
            state2 = failure[state2];
          }
          if (l in gotoFn[state2]) {
            const fs = gotoFn[state2][l];
            failure[s] = fs;
            output[s] = [...output[s], ...output[fs]];
          } else {
            failure[s] = 0;
          }
        }
      }
    }
    return {
      gotoFn,
      output,
      failure
    };
  }
  search(str) {
    let state = 0;
    const results = [];
    for (let i = 0; i < str.length; i++) {
      const l = str[i];
      while (state > 0 && !(l in this.gotoFn[state])) {
        state = this.failure[state];
      }
      if (!(l in this.gotoFn[state])) {
        continue;
      }
      state = this.gotoFn[state][l];
      if (this.output[state].length > 0) {
        const foundStrs = this.output[state];
        results.push([i, foundStrs]);
      }
    }
    return results;
  }
}
var mockAdapter = {
  appendCss: () => {
  },
  registerClassName: () => {
  },
  onEndFileScope: () => {
  },
  registerComposition: () => {
  },
  markCompositionUsed: () => {
  },
  getIdentOption: () => process.env.NODE_ENV === "production" ? "short" : "debug"
};
var adapterStack = [mockAdapter];
var currentAdapter = () => {
  if (adapterStack.length < 1) {
    throw new Error("No adapter configured");
  }
  return adapterStack[adapterStack.length - 1];
};
var hasConfiguredAdapter = false;
var setAdapterIfNotSet = (newAdapter) => {
  if (!hasConfiguredAdapter) {
    setAdapter(newAdapter);
  }
};
var setAdapter = (newAdapter) => {
  if (!newAdapter) {
    throw new Error('No adapter provided when calling "setAdapter"');
  }
  hasConfiguredAdapter = true;
  adapterStack.push(newAdapter);
};
var appendCss2 = function appendCss22() {
  return currentAdapter().appendCss(...arguments);
};
var markCompositionUsed2 = function markCompositionUsed22() {
  return currentAdapter().markCompositionUsed(...arguments);
};
var getIdentOption2 = function getIdentOption22() {
  var adapter = currentAdapter();
  if (!("getIdentOption" in adapter)) {
    return process.env.NODE_ENV === "production" ? "short" : "debug";
  }
  return adapter.getIdentOption(...arguments);
};
function _taggedTemplateLiteral(strings, raw) {
  if (!raw) {
    raw = strings.slice(0);
  }
  return Object.freeze(Object.defineProperties(strings, {
    raw: {
      value: Object.freeze(raw)
    }
  }));
}
var SelectorType;
(function(SelectorType2) {
  SelectorType2["Attribute"] = "attribute";
  SelectorType2["Pseudo"] = "pseudo";
  SelectorType2["PseudoElement"] = "pseudo-element";
  SelectorType2["Tag"] = "tag";
  SelectorType2["Universal"] = "universal";
  SelectorType2["Adjacent"] = "adjacent";
  SelectorType2["Child"] = "child";
  SelectorType2["Descendant"] = "descendant";
  SelectorType2["Parent"] = "parent";
  SelectorType2["Sibling"] = "sibling";
  SelectorType2["ColumnCombinator"] = "column-combinator";
})(SelectorType || (SelectorType = {}));
var AttributeAction;
(function(AttributeAction2) {
  AttributeAction2["Any"] = "any";
  AttributeAction2["Element"] = "element";
  AttributeAction2["End"] = "end";
  AttributeAction2["Equals"] = "equals";
  AttributeAction2["Exists"] = "exists";
  AttributeAction2["Hyphen"] = "hyphen";
  AttributeAction2["Not"] = "not";
  AttributeAction2["Start"] = "start";
})(AttributeAction || (AttributeAction = {}));
const reName = /^[^\\#]?(?:\\(?:[\da-f]{1,6}\s?|.)|[\w\-\u00b0-\uFFFF])+/;
const reEscape = /\\([\da-f]{1,6}\s?|(\s)|.)/gi;
const actionTypes = /* @__PURE__ */ new Map([
  [126, AttributeAction.Element],
  [94, AttributeAction.Start],
  [36, AttributeAction.End],
  [42, AttributeAction.Any],
  [33, AttributeAction.Not],
  [124, AttributeAction.Hyphen]
]);
const unpackPseudos = /* @__PURE__ */ new Set([
  "has",
  "not",
  "matches",
  "is",
  "where",
  "host",
  "host-context"
]);
function isTraversal(selector) {
  switch (selector.type) {
    case SelectorType.Adjacent:
    case SelectorType.Child:
    case SelectorType.Descendant:
    case SelectorType.Parent:
    case SelectorType.Sibling:
    case SelectorType.ColumnCombinator:
      return true;
    default:
      return false;
  }
}
const stripQuotesFromPseudos = /* @__PURE__ */ new Set(["contains", "icontains"]);
function funescape(_, escaped, escapedWhitespace) {
  const high = parseInt(escaped, 16) - 65536;
  return high !== high || escapedWhitespace ? escaped : high < 0 ? (
    // BMP codepoint
    String.fromCharCode(high + 65536)
  ) : (
    // Supplemental Plane codepoint (surrogate pair)
    String.fromCharCode(high >> 10 | 55296, high & 1023 | 56320)
  );
}
function unescapeCSS(str) {
  return str.replace(reEscape, funescape);
}
function isQuote(c) {
  return c === 39 || c === 34;
}
function isWhitespace(c) {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
}
function parse(selector) {
  const subselects = [];
  const endIndex = parseSelector(subselects, `${selector}`, 0);
  if (endIndex < selector.length) {
    throw new Error(`Unmatched selector: ${selector.slice(endIndex)}`);
  }
  return subselects;
}
function parseSelector(subselects, selector, selectorIndex) {
  let tokens = [];
  function getName(offset) {
    const match = selector.slice(selectorIndex + offset).match(reName);
    if (!match) {
      throw new Error(`Expected name, found ${selector.slice(selectorIndex)}`);
    }
    const [name] = match;
    selectorIndex += offset + name.length;
    return unescapeCSS(name);
  }
  function stripWhitespace(offset) {
    selectorIndex += offset;
    while (selectorIndex < selector.length && isWhitespace(selector.charCodeAt(selectorIndex))) {
      selectorIndex++;
    }
  }
  function readValueWithParenthesis() {
    selectorIndex += 1;
    const start = selectorIndex;
    let counter = 1;
    for (; counter > 0 && selectorIndex < selector.length; selectorIndex++) {
      if (selector.charCodeAt(selectorIndex) === 40 && !isEscaped(selectorIndex)) {
        counter++;
      } else if (selector.charCodeAt(selectorIndex) === 41 && !isEscaped(selectorIndex)) {
        counter--;
      }
    }
    if (counter) {
      throw new Error("Parenthesis not matched");
    }
    return unescapeCSS(selector.slice(start, selectorIndex - 1));
  }
  function isEscaped(pos) {
    let slashCount = 0;
    while (selector.charCodeAt(--pos) === 92)
      slashCount++;
    return (slashCount & 1) === 1;
  }
  function ensureNotTraversal() {
    if (tokens.length > 0 && isTraversal(tokens[tokens.length - 1])) {
      throw new Error("Did not expect successive traversals.");
    }
  }
  function addTraversal(type) {
    if (tokens.length > 0 && tokens[tokens.length - 1].type === SelectorType.Descendant) {
      tokens[tokens.length - 1].type = type;
      return;
    }
    ensureNotTraversal();
    tokens.push({ type });
  }
  function addSpecialAttribute(name, action) {
    tokens.push({
      type: SelectorType.Attribute,
      name,
      action,
      value: getName(1),
      namespace: null,
      ignoreCase: "quirks"
    });
  }
  function finalizeSubselector() {
    if (tokens.length && tokens[tokens.length - 1].type === SelectorType.Descendant) {
      tokens.pop();
    }
    if (tokens.length === 0) {
      throw new Error("Empty sub-selector");
    }
    subselects.push(tokens);
  }
  stripWhitespace(0);
  if (selector.length === selectorIndex) {
    return selectorIndex;
  }
  loop: while (selectorIndex < selector.length) {
    const firstChar = selector.charCodeAt(selectorIndex);
    switch (firstChar) {
      // Whitespace
      case 32:
      case 9:
      case 10:
      case 12:
      case 13: {
        if (tokens.length === 0 || tokens[0].type !== SelectorType.Descendant) {
          ensureNotTraversal();
          tokens.push({ type: SelectorType.Descendant });
        }
        stripWhitespace(1);
        break;
      }
      // Traversals
      case 62: {
        addTraversal(SelectorType.Child);
        stripWhitespace(1);
        break;
      }
      case 60: {
        addTraversal(SelectorType.Parent);
        stripWhitespace(1);
        break;
      }
      case 126: {
        addTraversal(SelectorType.Sibling);
        stripWhitespace(1);
        break;
      }
      case 43: {
        addTraversal(SelectorType.Adjacent);
        stripWhitespace(1);
        break;
      }
      // Special attribute selectors: .class, #id
      case 46: {
        addSpecialAttribute("class", AttributeAction.Element);
        break;
      }
      case 35: {
        addSpecialAttribute("id", AttributeAction.Equals);
        break;
      }
      case 91: {
        stripWhitespace(1);
        let name;
        let namespace = null;
        if (selector.charCodeAt(selectorIndex) === 124) {
          name = getName(1);
        } else if (selector.startsWith("*|", selectorIndex)) {
          namespace = "*";
          name = getName(2);
        } else {
          name = getName(0);
          if (selector.charCodeAt(selectorIndex) === 124 && selector.charCodeAt(selectorIndex + 1) !== 61) {
            namespace = name;
            name = getName(1);
          }
        }
        stripWhitespace(0);
        let action = AttributeAction.Exists;
        const possibleAction = actionTypes.get(selector.charCodeAt(selectorIndex));
        if (possibleAction) {
          action = possibleAction;
          if (selector.charCodeAt(selectorIndex + 1) !== 61) {
            throw new Error("Expected `=`");
          }
          stripWhitespace(2);
        } else if (selector.charCodeAt(selectorIndex) === 61) {
          action = AttributeAction.Equals;
          stripWhitespace(1);
        }
        let value = "";
        let ignoreCase = null;
        if (action !== "exists") {
          if (isQuote(selector.charCodeAt(selectorIndex))) {
            const quote = selector.charCodeAt(selectorIndex);
            let sectionEnd = selectorIndex + 1;
            while (sectionEnd < selector.length && (selector.charCodeAt(sectionEnd) !== quote || isEscaped(sectionEnd))) {
              sectionEnd += 1;
            }
            if (selector.charCodeAt(sectionEnd) !== quote) {
              throw new Error("Attribute value didn't end");
            }
            value = unescapeCSS(selector.slice(selectorIndex + 1, sectionEnd));
            selectorIndex = sectionEnd + 1;
          } else {
            const valueStart = selectorIndex;
            while (selectorIndex < selector.length && (!isWhitespace(selector.charCodeAt(selectorIndex)) && selector.charCodeAt(selectorIndex) !== 93 || isEscaped(selectorIndex))) {
              selectorIndex += 1;
            }
            value = unescapeCSS(selector.slice(valueStart, selectorIndex));
          }
          stripWhitespace(0);
          const forceIgnore = selector.charCodeAt(selectorIndex) | 32;
          if (forceIgnore === 115) {
            ignoreCase = false;
            stripWhitespace(1);
          } else if (forceIgnore === 105) {
            ignoreCase = true;
            stripWhitespace(1);
          }
        }
        if (selector.charCodeAt(selectorIndex) !== 93) {
          throw new Error("Attribute selector didn't terminate");
        }
        selectorIndex += 1;
        const attributeSelector = {
          type: SelectorType.Attribute,
          name,
          action,
          value,
          namespace,
          ignoreCase
        };
        tokens.push(attributeSelector);
        break;
      }
      case 58: {
        if (selector.charCodeAt(selectorIndex + 1) === 58) {
          tokens.push({
            type: SelectorType.PseudoElement,
            name: getName(2).toLowerCase(),
            data: selector.charCodeAt(selectorIndex) === 40 ? readValueWithParenthesis() : null
          });
          continue;
        }
        const name = getName(1).toLowerCase();
        let data = null;
        if (selector.charCodeAt(selectorIndex) === 40) {
          if (unpackPseudos.has(name)) {
            if (isQuote(selector.charCodeAt(selectorIndex + 1))) {
              throw new Error(`Pseudo-selector ${name} cannot be quoted`);
            }
            data = [];
            selectorIndex = parseSelector(data, selector, selectorIndex + 1);
            if (selector.charCodeAt(selectorIndex) !== 41) {
              throw new Error(`Missing closing parenthesis in :${name} (${selector})`);
            }
            selectorIndex += 1;
          } else {
            data = readValueWithParenthesis();
            if (stripQuotesFromPseudos.has(name)) {
              const quot = data.charCodeAt(0);
              if (quot === data.charCodeAt(data.length - 1) && isQuote(quot)) {
                data = data.slice(1, -1);
              }
            }
            data = unescapeCSS(data);
          }
        }
        tokens.push({ type: SelectorType.Pseudo, name, data });
        break;
      }
      case 44: {
        finalizeSubselector();
        tokens = [];
        stripWhitespace(1);
        break;
      }
      default: {
        if (selector.startsWith("/*", selectorIndex)) {
          const endIndex = selector.indexOf("*/", selectorIndex + 2);
          if (endIndex < 0) {
            throw new Error("Comment was not terminated");
          }
          selectorIndex = endIndex + 2;
          if (tokens.length === 0) {
            stripWhitespace(0);
          }
          break;
        }
        let namespace = null;
        let name;
        if (firstChar === 42) {
          selectorIndex += 1;
          name = "*";
        } else if (firstChar === 124) {
          name = "";
          if (selector.charCodeAt(selectorIndex + 1) === 124) {
            addTraversal(SelectorType.ColumnCombinator);
            stripWhitespace(2);
            break;
          }
        } else if (reName.test(selector.slice(selectorIndex))) {
          name = getName(0);
        } else {
          break loop;
        }
        if (selector.charCodeAt(selectorIndex) === 124 && selector.charCodeAt(selectorIndex + 1) !== 124) {
          namespace = name;
          if (selector.charCodeAt(selectorIndex + 1) === 42) {
            name = "*";
            selectorIndex += 2;
          } else {
            name = getName(1);
          }
        }
        tokens.push(name === "*" ? { type: SelectorType.Universal, namespace } : { type: SelectorType.Tag, name, namespace });
      }
    }
  }
  finalizeSubselector();
  return selectorIndex;
}
function ownKeys$1(object, enumerableOnly) {
  var keys = Object.keys(object);
  if (Object.getOwnPropertySymbols) {
    var symbols = Object.getOwnPropertySymbols(object);
    enumerableOnly && (symbols = symbols.filter(function(sym) {
      return Object.getOwnPropertyDescriptor(object, sym).enumerable;
    })), keys.push.apply(keys, symbols);
  }
  return keys;
}
function _objectSpread(target) {
  for (var i = 1; i < arguments.length; i++) {
    var source = null != arguments[i] ? arguments[i] : {};
    i % 2 ? ownKeys$1(Object(source), true).forEach(function(key) {
      _defineProperty$1(target, key, source[key]);
    }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)) : ownKeys$1(Object(source)).forEach(function(key) {
      Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key));
    });
  }
  return target;
}
function _defineProperty$1(obj, key, value) {
  key = _toPropertyKey(key);
  if (key in obj) {
    Object.defineProperty(obj, key, { value, enumerable: true, configurable: true, writable: true });
  } else {
    obj[key] = value;
  }
  return obj;
}
function _toPropertyKey(arg) {
  var key = _toPrimitive(arg, "string");
  return typeof key === "symbol" ? key : String(key);
}
function _toPrimitive(input, hint) {
  if (typeof input !== "object" || input === null) return input;
  var prim = input[Symbol.toPrimitive];
  if (prim !== void 0) {
    var res = prim.call(input, hint);
    if (typeof res !== "object") return res;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return (hint === "string" ? String : Number)(input);
}
const dedent = createDedent({});
function createDedent(options) {
  dedent2.withOptions = (newOptions) => createDedent(_objectSpread(_objectSpread({}, options), newOptions));
  return dedent2;
  function dedent2(strings, ...values) {
    const raw = typeof strings === "string" ? [strings] : strings.raw;
    const {
      alignValues = false,
      escapeSpecialCharacters = Array.isArray(strings),
      trimWhitespace = true
    } = options;
    let result = "";
    for (let i = 0; i < raw.length; i++) {
      let next = raw[i];
      if (escapeSpecialCharacters) {
        next = next.replace(/\\\n[ \t]*/g, "").replace(/\\`/g, "`").replace(/\\\$/g, "$").replace(/\\\{/g, "{");
      }
      result += next;
      if (i < values.length) {
        const value = alignValues ? alignValue(values[i], result) : values[i];
        result += value;
      }
    }
    const lines = result.split("\n");
    let mindent = null;
    for (const l of lines) {
      const m = l.match(/^(\s+)\S+/);
      if (m) {
        const indent = m[1].length;
        if (!mindent) {
          mindent = indent;
        } else {
          mindent = Math.min(mindent, indent);
        }
      }
    }
    if (mindent !== null) {
      const m = mindent;
      result = lines.map((l) => l[0] === " " || l[0] === "	" ? l.slice(m) : l).join("\n");
    }
    if (trimWhitespace) {
      result = result.trim();
    }
    if (escapeSpecialCharacters) {
      result = result.replace(/\\n/g, "\n");
    }
    return result;
  }
}
function alignValue(value, precedingText) {
  if (typeof value !== "string" || !value.includes("\n")) {
    return value;
  }
  const currentLine = precedingText.slice(precedingText.lastIndexOf("\n") + 1);
  const indentMatch = currentLine.match(/^(\s+)/);
  if (indentMatch) {
    const indent = indentMatch[1];
    return value.replace(/\n/g, `
${indent}`);
  }
  return value;
}
var __assign = function() {
  __assign = Object.assign || function __assign2(t) {
    for (var s, i = 1, n = arguments.length; i < n; i++) {
      s = arguments[i];
      for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p)) t[p] = s[p];
    }
    return t;
  };
  return __assign.apply(this, arguments);
};
function __rest(s, e) {
  var t = {};
  for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
    t[p] = s[p];
  if (s != null && typeof Object.getOwnPropertySymbols === "function")
    for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
      if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
        t[p[i]] = s[p[i]];
    }
  return t;
}
function __values(o) {
  var s = typeof Symbol === "function" && Symbol.iterator, m = s && o[s], i = 0;
  if (m) return m.call(o);
  if (o && typeof o.length === "number") return {
    next: function() {
      if (o && i >= o.length) o = void 0;
      return { value: o && o[i++], done: !o };
    }
  };
  throw new TypeError(s ? "Object is not iterable." : "Symbol.iterator is not defined.");
}
function __read(o, n) {
  var m = typeof Symbol === "function" && o[Symbol.iterator];
  if (!m) return o;
  var i = m.call(o), r2, ar = [], e;
  try {
    while ((n === void 0 || n-- > 0) && !(r2 = i.next()).done) ar.push(r2.value);
  } catch (error) {
    e = { error };
  } finally {
    try {
      if (r2 && !r2.done && (m = i["return"])) m.call(i);
    } finally {
      if (e) throw e.error;
    }
  }
  return ar;
}
var weirdNewlines = /(\u000D|\u000C|\u000D\u000A)/g;
var nullOrSurrogates = /[\u0000\uD800-\uDFFF]/g;
var commentRegex = /(\/\*)[\s\S]*?(\*\/)/g;
var lexicalAnalysis2 = function lexicalAnalysis22(str, index) {
  if (index === void 0) {
    index = 0;
  }
  str = str.replace(weirdNewlines, "\n").replace(nullOrSurrogates, "�");
  str = str.replace(commentRegex, "");
  var tokens = [];
  for (; index < str.length; index += 1) {
    var code = str.charCodeAt(index);
    if (code === 9 || code === 32 || code === 10) {
      var code_1 = str.charCodeAt(++index);
      while (code_1 === 9 || code_1 === 32 || code_1 === 10) {
        code_1 = str.charCodeAt(++index);
      }
      index -= 1;
      tokens.push({
        type: "<whitespace-token>"
      });
    } else if (code === 34) {
      var result = consumeString2(str, index);
      if (result === null) {
        return null;
      }
      var _a2 = __read(result, 2), lastIndex = _a2[0], value = _a2[1];
      tokens.push({
        type: "<string-token>",
        value
      });
      index = lastIndex;
    } else if (code === 35) {
      if (index + 1 < str.length) {
        var nextCode = str.charCodeAt(index + 1);
        if (nextCode === 95 || nextCode >= 65 && nextCode <= 90 || nextCode >= 97 && nextCode <= 122 || nextCode >= 128 || nextCode >= 48 && nextCode <= 57 || nextCode === 92 && index + 2 < str.length && str.charCodeAt(index + 2) !== 10) {
          var flag = wouldStartIdentifier2(str, index + 1) ? "id" : "unrestricted";
          var result = consumeIdentUnsafe2(str, index + 1);
          if (result !== null) {
            var _b2 = __read(result, 2), lastIndex = _b2[0], value = _b2[1];
            tokens.push({
              type: "<hash-token>",
              value: value.toLowerCase(),
              flag
            });
            index = lastIndex;
            continue;
          }
        }
      }
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    } else if (code === 39) {
      var result = consumeString2(str, index);
      if (result === null) {
        return null;
      }
      var _c = __read(result, 2), lastIndex = _c[0], value = _c[1];
      tokens.push({
        type: "<string-token>",
        value
      });
      index = lastIndex;
    } else if (code === 40) {
      tokens.push({
        type: "<(-token>"
      });
    } else if (code === 41) {
      tokens.push({
        type: "<)-token>"
      });
    } else if (code === 43) {
      var plusNumeric = consumeNumeric2(str, index);
      if (plusNumeric === null) {
        tokens.push({
          type: "<delim-token>",
          value: code
        });
      } else {
        var _d = __read(plusNumeric, 2), lastIndex = _d[0], tokenTuple = _d[1];
        if (tokenTuple[0] === "<dimension-token>") {
          tokens.push({
            type: "<dimension-token>",
            value: tokenTuple[1],
            unit: tokenTuple[2].toLowerCase(),
            flag: "number"
          });
        } else if (tokenTuple[0] === "<number-token>") {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: tokenTuple[2]
          });
        } else {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: "number"
          });
        }
        index = lastIndex;
      }
    } else if (code === 44) {
      tokens.push({
        type: "<comma-token>"
      });
    } else if (code === 45) {
      var minusNumeric = consumeNumeric2(str, index);
      if (minusNumeric !== null) {
        var _e = __read(minusNumeric, 2), lastIndex = _e[0], tokenTuple = _e[1];
        if (tokenTuple[0] === "<dimension-token>") {
          tokens.push({
            type: "<dimension-token>",
            value: tokenTuple[1],
            unit: tokenTuple[2].toLowerCase(),
            flag: "number"
          });
        } else if (tokenTuple[0] === "<number-token>") {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: tokenTuple[2]
          });
        } else {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: "number"
          });
        }
        index = lastIndex;
        continue;
      }
      if (index + 2 < str.length) {
        var nextCode = str.charCodeAt(index + 1);
        var nextNextCode = str.charCodeAt(index + 2);
        if (nextCode === 45 && nextNextCode === 62) {
          tokens.push({
            type: "<CDC-token>"
          });
          index += 2;
          continue;
        }
      }
      var result = consumeIdentLike2(str, index);
      if (result !== null) {
        var _f = __read(result, 3), lastIndex = _f[0], value = _f[1], type = _f[2];
        tokens.push({
          type,
          value
        });
        index = lastIndex;
        continue;
      }
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    } else if (code === 46) {
      var minusNumeric = consumeNumeric2(str, index);
      if (minusNumeric === null) {
        tokens.push({
          type: "<delim-token>",
          value: code
        });
      } else {
        var _g = __read(minusNumeric, 2), lastIndex = _g[0], tokenTuple = _g[1];
        if (tokenTuple[0] === "<dimension-token>") {
          tokens.push({
            type: "<dimension-token>",
            value: tokenTuple[1],
            unit: tokenTuple[2].toLowerCase(),
            flag: "number"
          });
        } else if (tokenTuple[0] === "<number-token>") {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: tokenTuple[2]
          });
        } else {
          tokens.push({
            type: tokenTuple[0],
            value: tokenTuple[1],
            flag: "number"
          });
        }
        index = lastIndex;
        continue;
      }
    } else if (code === 58) {
      tokens.push({
        type: "<colon-token>"
      });
    } else if (code === 59) {
      tokens.push({
        type: "<semicolon-token>"
      });
    } else if (code === 60) {
      if (index + 3 < str.length) {
        var nextCode = str.charCodeAt(index + 1);
        var nextNextCode = str.charCodeAt(index + 2);
        var nextNextNextCode = str.charCodeAt(index + 3);
        if (nextCode === 33 && nextNextCode === 45 && nextNextNextCode === 45) {
          tokens.push({
            type: "<CDO-token>"
          });
          index += 3;
          continue;
        }
      }
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    } else if (code === 64) {
      var result = consumeIdent2(str, index + 1);
      if (result !== null) {
        var _h = __read(result, 2), lastIndex = _h[0], value = _h[1];
        tokens.push({
          type: "<at-keyword-token>",
          value: value.toLowerCase()
        });
        index = lastIndex;
        continue;
      }
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    } else if (code === 91) {
      tokens.push({
        type: "<[-token>"
      });
    } else if (code === 92) {
      var result = consumeEscape2(str, index);
      if (result === null) {
        return null;
      }
      var _j = __read(result, 2), lastIndex = _j[0], value = _j[1];
      str = str.slice(0, index) + value + str.slice(lastIndex + 1);
      index -= 1;
    } else if (code === 93) {
      tokens.push({
        type: "<]-token>"
      });
    } else if (code === 123) {
      tokens.push({
        type: "<{-token>"
      });
    } else if (code === 125) {
      tokens.push({
        type: "<}-token>"
      });
    } else if (code >= 48 && code <= 57) {
      var result = consumeNumeric2(str, index);
      var _k = __read(result, 2), lastIndex = _k[0], tokenTuple = _k[1];
      if (tokenTuple[0] === "<dimension-token>") {
        tokens.push({
          type: "<dimension-token>",
          value: tokenTuple[1],
          unit: tokenTuple[2].toLowerCase(),
          flag: "number"
        });
      } else if (tokenTuple[0] === "<number-token>") {
        tokens.push({
          type: tokenTuple[0],
          value: tokenTuple[1],
          flag: tokenTuple[2]
        });
      } else {
        tokens.push({
          type: tokenTuple[0],
          value: tokenTuple[1],
          flag: "number"
        });
      }
      index = lastIndex;
    } else if (code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 128) {
      var result = consumeIdentLike2(str, index);
      if (result === null) {
        return null;
      }
      var _l = __read(result, 3), lastIndex = _l[0], value = _l[1], type = _l[2];
      tokens.push({
        type,
        value
      });
      index = lastIndex;
    } else {
      tokens.push({
        type: "<delim-token>",
        value: code
      });
    }
  }
  tokens.push({
    type: "<EOF-token>"
  });
  return tokens;
};
var consumeString2 = function consumeString22(str, index) {
  if (str.length <= index + 1) return null;
  var firstCode = str.charCodeAt(index);
  var charCodes = [];
  for (var i = index + 1; i < str.length; i += 1) {
    var code = str.charCodeAt(i);
    if (code === firstCode) {
      return [i, String.fromCharCode.apply(null, charCodes)];
    } else if (code === 92) {
      var result = consumeEscape2(str, i);
      if (result === null) return null;
      var _a2 = __read(result, 2), lastIndex = _a2[0], charCode = _a2[1];
      charCodes.push(charCode);
      i = lastIndex;
    } else if (code === 10) {
      return null;
    } else {
      charCodes.push(code);
    }
  }
  return null;
};
var wouldStartIdentifier2 = function wouldStartIdentifier22(str, index) {
  if (str.length <= index) return false;
  var code = str.charCodeAt(index);
  if (code === 45) {
    if (str.length <= index + 1) return false;
    var nextCode = str.charCodeAt(index + 1);
    if (nextCode === 45 || nextCode === 95 || nextCode >= 65 && nextCode <= 90 || nextCode >= 97 && nextCode <= 122 || nextCode >= 128) {
      return true;
    } else if (nextCode === 92) {
      if (str.length <= index + 2) return false;
      var nextNextCode = str.charCodeAt(index + 2);
      return nextNextCode !== 10;
    } else {
      return false;
    }
  } else if (code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 128) {
    return true;
  } else if (code === 92) {
    if (str.length <= index + 1) return false;
    var nextCode = str.charCodeAt(index + 1);
    return nextCode !== 10;
  } else {
    return false;
  }
};
var consumeEscape2 = function consumeEscape22(str, index) {
  if (str.length <= index + 1) return null;
  if (str.charCodeAt(index) !== 92) return null;
  var code = str.charCodeAt(index + 1);
  if (code === 10) {
    return null;
  } else if (code >= 48 && code <= 57 || code >= 65 && code <= 70 || code >= 97 && code <= 102) {
    var hexCharCodes = [code];
    var min = Math.min(index + 7, str.length);
    var i = index + 2;
    for (; i < min; i += 1) {
      var code_2 = str.charCodeAt(i);
      if (code_2 >= 48 && code_2 <= 57 || code_2 >= 65 && code_2 <= 70 || code_2 >= 97 && code_2 <= 102) {
        hexCharCodes.push(code_2);
      } else {
        break;
      }
    }
    if (i < str.length) {
      var code_3 = str.charCodeAt(i);
      if (code_3 === 9 || code_3 === 32 || code_3 === 10) {
        i += 1;
      }
    }
    return [i - 1, parseInt(String.fromCharCode.apply(null, hexCharCodes), 16)];
  } else {
    return [index + 1, code];
  }
};
var consumeNumeric2 = function consumeNumeric22(str, index) {
  var numberResult = consumeNumber2(str, index);
  if (numberResult === null) return null;
  var _a2 = __read(numberResult, 3), numberEndIndex = _a2[0], numberValue = _a2[1], numberFlag = _a2[2];
  var identResult = consumeIdent2(str, numberEndIndex + 1);
  if (identResult !== null) {
    var _b2 = __read(identResult, 2), identEndIndex = _b2[0], identValue = _b2[1];
    return [identEndIndex, ["<dimension-token>", numberValue, identValue]];
  }
  if (numberEndIndex + 1 < str.length && str.charCodeAt(numberEndIndex + 1) === 37) {
    return [numberEndIndex + 1, ["<percentage-token>", numberValue]];
  }
  return [numberEndIndex, ["<number-token>", numberValue, numberFlag]];
};
var consumeNumber2 = function consumeNumber22(str, index) {
  if (str.length <= index) return null;
  var flag = "integer";
  var numberChars = [];
  var firstCode = str.charCodeAt(index);
  if (firstCode === 43 || firstCode === 45) {
    index += 1;
    if (firstCode === 45) numberChars.push(45);
  }
  while (index < str.length) {
    var code = str.charCodeAt(index);
    if (code >= 48 && code <= 57) {
      numberChars.push(code);
      index += 1;
    } else {
      break;
    }
  }
  if (index + 1 < str.length) {
    var nextCode = str.charCodeAt(index);
    var nextNextCode = str.charCodeAt(index + 1);
    if (nextCode === 46 && nextNextCode >= 48 && nextNextCode <= 57) {
      numberChars.push(nextCode, nextNextCode);
      flag = "number";
      index += 2;
      while (index < str.length) {
        var code = str.charCodeAt(index);
        if (code >= 48 && code <= 57) {
          numberChars.push(code);
          index += 1;
        } else {
          break;
        }
      }
    }
  }
  if (index + 1 < str.length) {
    var nextCode = str.charCodeAt(index);
    var nextNextCode = str.charCodeAt(index + 1);
    var nextNextNextCode = str.charCodeAt(index + 2);
    if (nextCode === 69 || nextCode === 101) {
      var nextNextIsDigit = nextNextCode >= 48 && nextNextCode <= 57;
      if (nextNextIsDigit || (nextNextCode === 43 || nextNextCode === 45) && nextNextNextCode >= 48 && nextNextNextCode <= 57) {
        flag = "number";
        if (nextNextIsDigit) {
          numberChars.push(69, nextNextCode);
          index += 2;
        } else if (nextNextCode === 45) {
          numberChars.push(69, 45, nextNextNextCode);
          index += 3;
        } else {
          numberChars.push(69, nextNextNextCode);
          index += 3;
        }
        while (index < str.length) {
          var code = str.charCodeAt(index);
          if (code >= 48 && code <= 57) {
            numberChars.push(code);
            index += 1;
          } else {
            break;
          }
        }
      }
    }
  }
  var numberString = String.fromCharCode.apply(null, numberChars);
  var value = flag === "number" ? parseFloat(numberString) : parseInt(numberString);
  if (value === -0) value = 0;
  return Number.isNaN(value) ? null : [index - 1, value, flag];
};
var consumeIdentUnsafe2 = function consumeIdentUnsafe22(str, index) {
  if (str.length <= index) {
    return null;
  }
  var identChars = [];
  for (var code = str.charCodeAt(index); index < str.length; code = str.charCodeAt(++index)) {
    if (code === 45 || code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 128 || code >= 48 && code <= 57) {
      identChars.push(code);
      continue;
    } else {
      var result = consumeEscape2(str, index);
      if (result !== null) {
        var _a2 = __read(result, 2), lastIndex = _a2[0], code_4 = _a2[1];
        identChars.push(code_4);
        index = lastIndex;
        continue;
      }
    }
    break;
  }
  return index === 0 ? null : [index - 1, String.fromCharCode.apply(null, identChars)];
};
var consumeIdent2 = function consumeIdent22(str, index) {
  if (str.length <= index || !wouldStartIdentifier2(str, index)) {
    return null;
  }
  var identChars = [];
  for (var code = str.charCodeAt(index); index < str.length; code = str.charCodeAt(++index)) {
    if (code === 45 || code === 95 || code >= 65 && code <= 90 || code >= 97 && code <= 122 || code >= 128 || code >= 48 && code <= 57) {
      identChars.push(code);
      continue;
    } else {
      var result = consumeEscape2(str, index);
      if (result !== null) {
        var _a2 = __read(result, 2), lastIndex = _a2[0], code_5 = _a2[1];
        identChars.push(code_5);
        index = lastIndex;
        continue;
      }
    }
    break;
  }
  return [index - 1, String.fromCharCode.apply(null, identChars)];
};
var consumeUrl2 = function consumeUrl22(str, index) {
  var code = str.charCodeAt(index);
  while (code === 9 || code === 32 || code === 10) {
    code = str.charCodeAt(++index);
  }
  var urlChars = [];
  var hasFinishedWord = false;
  while (index < str.length) {
    if (code === 41) {
      return [index, String.fromCharCode.apply(null, urlChars)];
    } else if (code === 34 || code === 39 || code === 40) {
      return null;
    } else if (code === 9 || code === 32 || code === 10) {
      if (!hasFinishedWord && urlChars.length !== 0) hasFinishedWord = true;
    } else if (code === 92) {
      var result = consumeEscape2(str, index);
      if (result === null || hasFinishedWord) return null;
      var _a2 = __read(result, 2), lastIndex = _a2[0], value = _a2[1];
      urlChars.push(value);
      index = lastIndex;
    } else {
      if (hasFinishedWord) return null;
      urlChars.push(code);
    }
    code = str.charCodeAt(++index);
  }
  return null;
};
var consumeIdentLike2 = function consumeIdentLike22(str, index) {
  var result = consumeIdent2(str, index);
  if (result === null) return null;
  var _a2 = __read(result, 2), lastIndex = _a2[0], value = _a2[1];
  if (value.toLowerCase() === "url") {
    if (str.length > lastIndex + 1) {
      var nextCode = str.charCodeAt(lastIndex + 1);
      if (nextCode === 40) {
        for (var offset = 2; lastIndex + offset < str.length; offset += 1) {
          var nextNextCode = str.charCodeAt(lastIndex + offset);
          if (nextNextCode === 34 || nextNextCode === 39) {
            return [lastIndex + 1, value.toLowerCase(), "<function-token>"];
          } else if (nextNextCode !== 9 && nextNextCode !== 32 && nextNextCode !== 10) {
            var result_1 = consumeUrl2(str, lastIndex + offset);
            if (result_1 === null) return null;
            var _b2 = __read(result_1, 2), lastUrlIndex = _b2[0], value_1 = _b2[1];
            return [lastUrlIndex, value_1, "<url-token>"];
          }
        }
        return [lastIndex + 1, value.toLowerCase(), "<function-token>"];
      }
    }
  } else if (str.length > lastIndex + 1) {
    var nextCode = str.charCodeAt(lastIndex + 1);
    if (nextCode === 40) {
      return [lastIndex + 1, value.toLowerCase(), "<function-token>"];
    }
  }
  return [lastIndex, value.toLowerCase(), "<ident-token>"];
};
var simplifyAST2 = function simplifyAST22(ast) {
  for (var i = ast.length - 1; i >= 0; i--) {
    ast[i] = simplifyMediaQuery2(ast[i]);
  }
  return ast;
};
var simplifyMediaQuery2 = function simplifyMediaQuery22(mediaQuery) {
  if (mediaQuery.mediaCondition === null) return mediaQuery;
  var mediaCondition = simplifyMediaCondition2(mediaQuery.mediaCondition);
  if (mediaCondition.operator === null && mediaCondition.children.length === 1 && "children" in mediaCondition.children[0]) {
    mediaCondition = mediaCondition.children[0];
  }
  return {
    mediaPrefix: mediaQuery.mediaPrefix,
    mediaType: mediaQuery.mediaType,
    mediaCondition
  };
};
var simplifyMediaCondition2 = function simplifyMediaCondition22(mediaCondition) {
  for (var i = mediaCondition.children.length - 1; i >= 0; i--) {
    var unsimplifiedChild = mediaCondition.children[i];
    if (!("context" in unsimplifiedChild)) {
      var child = simplifyMediaCondition22(unsimplifiedChild);
      if (child.operator === null && child.children.length === 1) {
        mediaCondition.children[i] = child.children[0];
      } else if (child.operator === mediaCondition.operator && (child.operator === "and" || child.operator === "or")) {
        var spliceArgs = [i, 1];
        for (var i_1 = 0; i_1 < child.children.length; i_1++) {
          spliceArgs.push(child.children[i_1]);
        }
        mediaCondition.children.splice.apply(mediaCondition.children, spliceArgs);
      }
    }
  }
  return mediaCondition;
};
var createError2 = function createError22(message, err) {
  if (err instanceof Error) {
    return new Error("".concat(err.message.trim(), "\n").concat(message.trim()));
  } else {
    return new Error(message.trim());
  }
};
var toAST2 = function toAST22(str) {
  return simplifyAST2(toUnflattenedAST2(str));
};
var toUnflattenedAST2 = function toUnflattenedAST22(str) {
  var tokenList = lexicalAnalysis2(str.trim());
  if (tokenList === null) {
    throw createError2("Failed tokenizing");
  }
  var startIndex = 0;
  var endIndex = tokenList.length - 1;
  if (tokenList[0].type === "<at-keyword-token>" && tokenList[0].value === "media") {
    if (tokenList[1].type !== "<whitespace-token>") {
      throw createError2("Expected whitespace after media");
    }
    startIndex = 2;
    for (var i = 2; i < tokenList.length - 1; i++) {
      var token = tokenList[i];
      if (token.type === "<{-token>") {
        endIndex = i;
        break;
      } else if (token.type === "<semicolon-token>") {
        throw createError2("Expected '{' in media query but found ';'");
      }
    }
  }
  tokenList = tokenList.slice(startIndex, endIndex);
  return syntacticAnalysis2(tokenList);
};
var removeWhitespace2 = function removeWhitespace22(tokenList) {
  var newTokenList = [];
  var before = false;
  for (var i = 0; i < tokenList.length; i++) {
    if (tokenList[i].type === "<whitespace-token>") {
      before = true;
      if (newTokenList.length > 0) {
        newTokenList[newTokenList.length - 1].wsAfter = true;
      }
    } else {
      newTokenList.push(__assign(__assign({}, tokenList[i]), {
        wsBefore: before,
        wsAfter: false
      }));
      before = false;
    }
  }
  return newTokenList;
};
var syntacticAnalysis2 = function syntacticAnalysis22(tokenList) {
  var e_1, _a2;
  var mediaQueryList = [[]];
  for (var i = 0; i < tokenList.length; i++) {
    var token = tokenList[i];
    if (token.type === "<comma-token>") {
      mediaQueryList.push([]);
    } else {
      mediaQueryList[mediaQueryList.length - 1].push(token);
    }
  }
  var mediaQueries = mediaQueryList.map(removeWhitespace2);
  if (mediaQueries.length === 1 && mediaQueries[0].length === 0) {
    return [{
      mediaCondition: null,
      mediaPrefix: null,
      mediaType: "all"
    }];
  } else {
    var mediaQueryTokens = mediaQueries.map(function(mediaQueryTokens2) {
      if (mediaQueryTokens2.length === 0) {
        return null;
      } else {
        return tokenizeMediaQuery2(mediaQueryTokens2);
      }
    });
    var nonNullMediaQueryTokens = [];
    try {
      for (var mediaQueryTokens_1 = __values(mediaQueryTokens), mediaQueryTokens_1_1 = mediaQueryTokens_1.next(); !mediaQueryTokens_1_1.done; mediaQueryTokens_1_1 = mediaQueryTokens_1.next()) {
        var mediaQueryToken = mediaQueryTokens_1_1.value;
        if (mediaQueryToken !== null) {
          nonNullMediaQueryTokens.push(mediaQueryToken);
        }
      }
    } catch (e_1_1) {
      e_1 = {
        error: e_1_1
      };
    } finally {
      try {
        if (mediaQueryTokens_1_1 && !mediaQueryTokens_1_1.done && (_a2 = mediaQueryTokens_1["return"])) _a2.call(mediaQueryTokens_1);
      } finally {
        if (e_1) throw e_1.error;
      }
    }
    if (nonNullMediaQueryTokens.length === 0) {
      throw createError2("No valid media queries");
    }
    return nonNullMediaQueryTokens;
  }
};
var tokenizeMediaQuery2 = function tokenizeMediaQuery22(tokens) {
  var firstToken = tokens[0];
  if (firstToken.type === "<(-token>") {
    try {
      return {
        mediaPrefix: null,
        mediaType: "all",
        mediaCondition: tokenizeMediaCondition2(tokens, true)
      };
    } catch (err) {
      throw createError2("Expected media condition after '('", err);
    }
  } else if (firstToken.type === "<ident-token>") {
    var mediaPrefix = null;
    var mediaType = void 0;
    var value = firstToken.value;
    if (value === "only" || value === "not") {
      mediaPrefix = value;
    }
    var firstIndex = mediaPrefix === null ? 0 : 1;
    if (tokens.length <= firstIndex) {
      throw createError2("Expected extra token in media query");
    }
    var firstNonUnaryToken = tokens[firstIndex];
    if (firstNonUnaryToken.type === "<ident-token>") {
      var value_1 = firstNonUnaryToken.value;
      if (value_1 === "all") {
        mediaType = "all";
      } else if (value_1 === "print" || value_1 === "screen") {
        mediaType = value_1;
      } else if (value_1 === "tty" || value_1 === "tv" || value_1 === "projection" || value_1 === "handheld" || value_1 === "braille" || value_1 === "embossed" || value_1 === "aural" || value_1 === "speech") {
        mediaPrefix = mediaPrefix === "not" ? null : "not";
        mediaType = "all";
      } else {
        throw createError2("Unknown ident '".concat(value_1, "' in media query"));
      }
    } else if (mediaPrefix === "not" && firstNonUnaryToken.type === "<(-token>") {
      var tokensWithParens = [{
        type: "<(-token>",
        wsBefore: false,
        wsAfter: false
      }];
      tokensWithParens.push.apply(tokensWithParens, tokens);
      tokensWithParens.push({
        type: "<)-token>",
        wsBefore: false,
        wsAfter: false
      });
      try {
        return {
          mediaPrefix: null,
          mediaType: "all",
          mediaCondition: tokenizeMediaCondition2(tokensWithParens, true)
        };
      } catch (err) {
        throw createError2("Expected media condition after '('", err);
      }
    } else {
      throw createError2("Invalid media query");
    }
    if (firstIndex + 1 === tokens.length) {
      return {
        mediaPrefix,
        mediaType,
        mediaCondition: null
      };
    } else if (firstIndex + 4 < tokens.length) {
      var secondNonUnaryToken = tokens[firstIndex + 1];
      if (secondNonUnaryToken.type === "<ident-token>" && secondNonUnaryToken.value === "and") {
        try {
          return {
            mediaPrefix,
            mediaType,
            mediaCondition: tokenizeMediaCondition2(tokens.slice(firstIndex + 2), false)
          };
        } catch (err) {
          throw createError2("Expected media condition after 'and'", err);
        }
      } else {
        throw createError2("Expected 'and' after media prefix");
      }
    } else {
      throw createError2("Expected media condition after media prefix");
    }
  } else {
    throw createError2("Expected media condition or media prefix");
  }
};
var tokenizeMediaCondition2 = function tokenizeMediaCondition22(tokens, mayContainOr, previousOperator) {
  if (previousOperator === void 0) {
    previousOperator = null;
  }
  if (tokens.length < 3 || tokens[0].type !== "<(-token>" || tokens[tokens.length - 1].type !== "<)-token>") {
    throw new Error("Invalid media condition");
  }
  var endIndexOfFirstFeature = tokens.length - 1;
  var maxDepth = 0;
  var count = 0;
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (token.type === "<(-token>") {
      count += 1;
      maxDepth = Math.max(maxDepth, count);
    } else if (token.type === "<)-token>") {
      count -= 1;
    }
    if (count === 0) {
      endIndexOfFirstFeature = i;
      break;
    }
  }
  if (count !== 0) {
    throw new Error("Mismatched parens\nInvalid media condition");
  }
  var child;
  var featureTokens = tokens.slice(0, endIndexOfFirstFeature + 1);
  if (maxDepth === 1) {
    child = tokenizeMediaFeature2(featureTokens);
  } else {
    if (featureTokens[1].type === "<ident-token>" && featureTokens[1].value === "not") {
      child = tokenizeMediaCondition22(featureTokens.slice(2, -1), true, "not");
    } else {
      child = tokenizeMediaCondition22(featureTokens.slice(1, -1), true);
    }
  }
  if (endIndexOfFirstFeature === tokens.length - 1) {
    return {
      operator: previousOperator,
      children: [child]
    };
  } else {
    var nextToken = tokens[endIndexOfFirstFeature + 1];
    if (nextToken.type !== "<ident-token>") {
      throw new Error("Invalid operator\nInvalid media condition");
    } else if (previousOperator !== null && previousOperator !== nextToken.value) {
      throw new Error("'".concat(nextToken.value, "' and '").concat(previousOperator, "' must not be at same level\nInvalid media condition"));
    } else if (nextToken.value === "or" && !mayContainOr) {
      throw new Error("Cannot use 'or' at top level of a media query\nInvalid media condition");
    } else if (nextToken.value !== "and" && nextToken.value !== "or") {
      throw new Error("Invalid operator: '".concat(nextToken.value, "'\nInvalid media condition"));
    }
    var siblings = tokenizeMediaCondition22(tokens.slice(endIndexOfFirstFeature + 2), mayContainOr, nextToken.value);
    return {
      operator: nextToken.value,
      children: [child].concat(siblings.children)
    };
  }
};
var tokenizeMediaFeature2 = function tokenizeMediaFeature22(rawTokens) {
  if (rawTokens.length < 3 || rawTokens[0].type !== "<(-token>" || rawTokens[rawTokens.length - 1].type !== "<)-token>") {
    throw new Error("Invalid media feature");
  }
  var tokens = [rawTokens[0]];
  for (var i = 1; i < rawTokens.length; i++) {
    if (i < rawTokens.length - 2) {
      var a = rawTokens[i];
      var b = rawTokens[i + 1];
      var c = rawTokens[i + 2];
      if (a.type === "<number-token>" && a.value > 0 && b.type === "<delim-token>" && b.value === 47 && c.type === "<number-token>" && c.value > 0) {
        tokens.push({
          type: "<ratio-token>",
          numerator: a.value,
          denominator: c.value,
          wsBefore: a.wsBefore,
          wsAfter: c.wsAfter
        });
        i += 2;
        continue;
      }
    }
    tokens.push(rawTokens[i]);
  }
  var nextToken = tokens[1];
  if (nextToken.type === "<ident-token>" && tokens.length === 3) {
    return {
      context: "boolean",
      feature: nextToken.value
    };
  } else if (tokens.length === 5 && tokens[1].type === "<ident-token>" && tokens[2].type === "<colon-token>") {
    var valueToken = tokens[3];
    if (valueToken.type === "<number-token>" || valueToken.type === "<dimension-token>" || valueToken.type === "<ratio-token>" || valueToken.type === "<ident-token>") {
      var feature = tokens[1].value;
      var prefix = null;
      var slice = feature.slice(0, 4);
      if (slice === "min-") {
        prefix = "min";
        feature = feature.slice(4);
      } else if (slice === "max-") {
        prefix = "max";
        feature = feature.slice(4);
      }
      valueToken.wsBefore;
      valueToken.wsAfter;
      var value = __rest(valueToken, ["wsBefore", "wsAfter"]);
      return {
        context: "value",
        prefix,
        feature,
        value
      };
    }
  } else if (tokens.length >= 5) {
    try {
      var range = tokenizeRange2(tokens);
      return {
        context: "range",
        feature: range.featureName,
        range
      };
    } catch (err) {
      throw createError2("Invalid media feature", err);
    }
  }
  throw new Error("Invalid media feature");
};
var tokenizeRange2 = function tokenizeRange22(tokens) {
  var _a2, _b2, _c, _d;
  if (tokens.length < 5 || tokens[0].type !== "<(-token>" || tokens[tokens.length - 1].type !== "<)-token>") {
    throw new Error("Invalid range");
  }
  var range = {
    leftToken: null,
    leftOp: null,
    featureName: "",
    rightOp: null,
    rightToken: null
  };
  var hasLeft = tokens[1].type === "<number-token>" || tokens[1].type === "<dimension-token>" || tokens[1].type === "<ratio-token>" || tokens[1].type === "<ident-token>" && tokens[1].value === "infinite";
  if (tokens[2].type === "<delim-token>") {
    if (tokens[2].value === 60) {
      if (tokens[3].type === "<delim-token>" && tokens[3].value === 61 && !tokens[3].wsBefore) {
        range[hasLeft ? "leftOp" : "rightOp"] = "<=";
      } else {
        range[hasLeft ? "leftOp" : "rightOp"] = "<";
      }
    } else if (tokens[2].value === 62) {
      if (tokens[3].type === "<delim-token>" && tokens[3].value === 61 && !tokens[3].wsBefore) {
        range[hasLeft ? "leftOp" : "rightOp"] = ">=";
      } else {
        range[hasLeft ? "leftOp" : "rightOp"] = ">";
      }
    } else if (tokens[2].value === 61) {
      range[hasLeft ? "leftOp" : "rightOp"] = "=";
    } else {
      throw new Error("Invalid range");
    }
    if (hasLeft) {
      range.leftToken = tokens[1];
    } else if (tokens[1].type === "<ident-token>") {
      range.featureName = tokens[1].value;
    } else {
      throw new Error("Invalid range");
    }
    var tokenIndexAfterFirstOp = 2 + ((_b2 = (_a2 = range[hasLeft ? "leftOp" : "rightOp"]) === null || _a2 === void 0 ? void 0 : _a2.length) !== null && _b2 !== void 0 ? _b2 : 0);
    var tokenAfterFirstOp = tokens[tokenIndexAfterFirstOp];
    if (hasLeft) {
      if (tokenAfterFirstOp.type === "<ident-token>") {
        range.featureName = tokenAfterFirstOp.value;
        if (tokens.length >= 7) {
          var secondOpToken = tokens[tokenIndexAfterFirstOp + 1];
          var followingToken = tokens[tokenIndexAfterFirstOp + 2];
          if (secondOpToken.type === "<delim-token>") {
            var charCode = secondOpToken.value;
            if (charCode === 60) {
              if (followingToken.type === "<delim-token>" && followingToken.value === 61 && !followingToken.wsBefore) {
                range.rightOp = "<=";
              } else {
                range.rightOp = "<";
              }
            } else if (charCode === 62) {
              if (followingToken.type === "<delim-token>" && followingToken.value === 61 && !followingToken.wsBefore) {
                range.rightOp = ">=";
              } else {
                range.rightOp = ">";
              }
            } else {
              throw new Error("Invalid range");
            }
            var tokenAfterSecondOp = tokens[tokenIndexAfterFirstOp + 1 + ((_d = (_c = range.rightOp) === null || _c === void 0 ? void 0 : _c.length) !== null && _d !== void 0 ? _d : 0)];
            range.rightToken = tokenAfterSecondOp;
          } else {
            throw new Error("Invalid range");
          }
        } else if (tokenIndexAfterFirstOp + 2 !== tokens.length) {
          throw new Error("Invalid range");
        }
      } else {
        throw new Error("Invalid range");
      }
    } else {
      range.rightToken = tokenAfterFirstOp;
    }
    var validRange = null;
    var lt = range.leftToken, leftOp = range.leftOp, featureName = range.featureName, rightOp = range.rightOp, rt = range.rightToken;
    var leftToken = null;
    if (lt !== null) {
      if (lt.type === "<ident-token>") {
        var type = lt.type, value = lt.value;
        if (value === "infinite") {
          leftToken = {
            type,
            value
          };
        }
      } else if (lt.type === "<number-token>" || lt.type === "<dimension-token>" || lt.type === "<ratio-token>") {
        lt.wsBefore;
        lt.wsAfter;
        var ltNoWS = __rest(lt, ["wsBefore", "wsAfter"]);
        leftToken = ltNoWS;
      }
    }
    var rightToken = null;
    if (rt !== null) {
      if (rt.type === "<ident-token>") {
        var type = rt.type, value = rt.value;
        if (value === "infinite") {
          rightToken = {
            type,
            value
          };
        }
      } else if (rt.type === "<number-token>" || rt.type === "<dimension-token>" || rt.type === "<ratio-token>") {
        rt.wsBefore;
        rt.wsAfter;
        var rtNoWS = __rest(rt, ["wsBefore", "wsAfter"]);
        rightToken = rtNoWS;
      }
    }
    if (leftToken !== null && rightToken !== null) {
      if ((leftOp === "<" || leftOp === "<=") && (rightOp === "<" || rightOp === "<=")) {
        validRange = {
          leftToken,
          leftOp,
          featureName,
          rightOp,
          rightToken
        };
      } else if ((leftOp === ">" || leftOp === ">=") && (rightOp === ">" || rightOp === ">=")) {
        validRange = {
          leftToken,
          leftOp,
          featureName,
          rightOp,
          rightToken
        };
      } else {
        throw new Error("Invalid range");
      }
    } else if (leftToken === null && leftOp === null && rightOp !== null && rightToken !== null) {
      validRange = {
        leftToken,
        leftOp,
        featureName,
        rightOp,
        rightToken
      };
    } else if (leftToken !== null && leftOp !== null && rightOp === null && rightToken === null) {
      validRange = {
        leftToken,
        leftOp,
        featureName,
        rightOp,
        rightToken
      };
    }
    return validRange;
  } else {
    throw new Error("Invalid range");
  }
};
function toPrimitive(t, r2) {
  if ("object" != typeof t || !t) return t;
  var e = t[Symbol.toPrimitive];
  if (void 0 !== e) {
    var i = e.call(t, r2);
    if ("object" != typeof i) return i;
    throw new TypeError("@@toPrimitive must return a primitive value.");
  }
  return ("string" === r2 ? String : Number)(t);
}
function toPropertyKey(t) {
  var i = toPrimitive(t, "string");
  return "symbol" == typeof i ? i : String(i);
}
function _defineProperty(obj, key, value) {
  key = toPropertyKey(key);
  if (key in obj) {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
  } else {
    obj[key] = value;
  }
  return obj;
}
function ownKeys(e, r2) {
  var t = Object.keys(e);
  if (Object.getOwnPropertySymbols) {
    var o = Object.getOwnPropertySymbols(e);
    r2 && (o = o.filter(function(r22) {
      return Object.getOwnPropertyDescriptor(e, r22).enumerable;
    })), t.push.apply(t, o);
  }
  return t;
}
function _objectSpread2(e) {
  for (var r2 = 1; r2 < arguments.length; r2++) {
    var t = null != arguments[r2] ? arguments[r2] : {};
    r2 % 2 ? ownKeys(Object(t), true).forEach(function(r22) {
      _defineProperty(e, r22, t[r22]);
    }) : Object.getOwnPropertyDescriptors ? Object.defineProperties(e, Object.getOwnPropertyDescriptors(t)) : ownKeys(Object(t)).forEach(function(r22) {
      Object.defineProperty(e, r22, Object.getOwnPropertyDescriptor(t, r22));
    });
  }
  return e;
}
function _objectWithoutPropertiesLoose(source, excluded) {
  if (source == null) return {};
  var target = {};
  var sourceKeys = Object.keys(source);
  var key, i;
  for (i = 0; i < sourceKeys.length; i++) {
    key = sourceKeys[i];
    if (excluded.indexOf(key) >= 0) continue;
    target[key] = source[key];
  }
  return target;
}
function _objectWithoutProperties(source, excluded) {
  if (source == null) return {};
  var target = _objectWithoutPropertiesLoose(source, excluded);
  var key, i;
  if (Object.getOwnPropertySymbols) {
    var sourceSymbolKeys = Object.getOwnPropertySymbols(source);
    for (i = 0; i < sourceSymbolKeys.length; i++) {
      key = sourceSymbolKeys[i];
      if (excluded.indexOf(key) >= 0) continue;
      if (!Object.prototype.propertyIsEnumerable.call(source, key)) continue;
      target[key] = source[key];
    }
  }
  return target;
}
function forEach(obj, fn) {
  for (var _key in obj) {
    fn(obj[_key], _key);
  }
}
function omit(obj, omitKeys) {
  var result = {};
  for (var _key2 in obj) {
    if (omitKeys.indexOf(_key2) === -1) {
      result[_key2] = obj[_key2];
    }
  }
  return result;
}
function mapKeys(obj, fn) {
  var result = {};
  for (var _key3 in obj) {
    result[fn(obj[_key3], _key3)] = obj[_key3];
  }
  return result;
}
var _templateObject$1$1;
function escapeRegex(string) {
  return string.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
}
var validateSelector = (selector, targetClassName) => {
  var replaceTarget = () => {
    var targetRegex = new RegExp(".".concat(escapeRegex(cssesc(targetClassName, {
      isIdentifier: true
    }))), "g");
    return selector.replace(targetRegex, "&");
  };
  var selectorParts;
  try {
    selectorParts = parse(selector);
  } catch (err) {
    throw new Error("Invalid selector: ".concat(replaceTarget()));
  }
  selectorParts.forEach((tokens) => {
    try {
      for (var i = tokens.length - 1; i >= -1; i--) {
        if (!tokens[i]) {
          throw new Error();
        }
        var token = tokens[i];
        if (token.type === "child" || token.type === "parent" || token.type === "sibling" || token.type === "adjacent" || token.type === "descendant") {
          throw new Error();
        }
        if (token.type === "attribute" && token.name === "class" && token.value === targetClassName) {
          return;
        }
      }
    } catch (err) {
      throw new Error(dedent(_templateObject$1$1 || (_templateObject$1$1 = _taggedTemplateLiteral(["\n        Invalid selector: ", "\n    \n        Style selectors must target the '&' character (along with any modifiers), e.g. ", " or ", ".\n        \n        This is to ensure that each style block only affects the styling of a single class.\n        \n        If your selector is targeting another class, you should move it to the style definition for that class, e.g. given we have styles for 'parent' and 'child' elements, instead of adding a selector of ", ") to 'parent', you should add ", " to 'child').\n        \n        If your selector is targeting something global, use the 'globalStyle' function instead, e.g. if you wanted to write ", ", you should instead write 'globalStyle(", ", { ... })'\n      "])), replaceTarget(), "`${parent} &`", "`${parent} &:hover`", "`& ${child}`", "`${parent} &`", "`& h1`", "`${parent} h1`"));
    }
  });
};
class ConditionalRuleset2 {
  /**
   * Stores information about where conditions must be in relation to other conditions
   *
   * e.g. mobile -> tablet, desktop
   */
  constructor() {
    this.ruleset = /* @__PURE__ */ new Map();
    this.precedenceLookup = /* @__PURE__ */ new Map();
  }
  findOrCreateCondition(conditionQuery) {
    var targetCondition = this.ruleset.get(conditionQuery);
    if (!targetCondition) {
      targetCondition = {
        query: conditionQuery,
        rules: [],
        children: new ConditionalRuleset2()
      };
      this.ruleset.set(conditionQuery, targetCondition);
    }
    return targetCondition;
  }
  getConditionalRulesetByPath(conditionPath) {
    var currRuleset = this;
    for (var query of conditionPath) {
      var condition = currRuleset.findOrCreateCondition(query);
      currRuleset = condition.children;
    }
    return currRuleset;
  }
  addRule(rule, conditionQuery, conditionPath) {
    var ruleset = this.getConditionalRulesetByPath(conditionPath);
    var targetCondition = ruleset.findOrCreateCondition(conditionQuery);
    if (!targetCondition) {
      throw new Error("Failed to add conditional rule");
    }
    targetCondition.rules.push(rule);
  }
  addConditionPrecedence(conditionPath, conditionOrder) {
    var ruleset = this.getConditionalRulesetByPath(conditionPath);
    for (var i = 0; i < conditionOrder.length; i++) {
      var _ruleset$precedenceLo;
      var query = conditionOrder[i];
      var conditionPrecedence = (_ruleset$precedenceLo = ruleset.precedenceLookup.get(query)) !== null && _ruleset$precedenceLo !== void 0 ? _ruleset$precedenceLo : /* @__PURE__ */ new Set();
      for (var lowerPrecedenceCondition of conditionOrder.slice(i + 1)) {
        conditionPrecedence.add(lowerPrecedenceCondition);
      }
      ruleset.precedenceLookup.set(query, conditionPrecedence);
    }
  }
  isCompatible(incomingRuleset) {
    for (var [condition, orderPrecedence] of this.precedenceLookup.entries()) {
      for (var lowerPrecedenceCondition of orderPrecedence) {
        var _incomingRuleset$prec;
        if ((_incomingRuleset$prec = incomingRuleset.precedenceLookup.get(lowerPrecedenceCondition)) !== null && _incomingRuleset$prec !== void 0 && _incomingRuleset$prec.has(condition)) {
          return false;
        }
      }
    }
    for (var {
      query,
      children
    } of incomingRuleset.ruleset.values()) {
      var matchingCondition = this.ruleset.get(query);
      if (matchingCondition && !matchingCondition.children.isCompatible(children)) {
        return false;
      }
    }
    return true;
  }
  merge(incomingRuleset) {
    for (var {
      query,
      rules,
      children
    } of incomingRuleset.ruleset.values()) {
      var matchingCondition = this.ruleset.get(query);
      if (matchingCondition) {
        matchingCondition.rules.push(...rules);
        matchingCondition.children.merge(children);
      } else {
        this.ruleset.set(query, {
          query,
          rules,
          children
        });
      }
    }
    for (var [condition, incomingOrderPrecedence] of incomingRuleset.precedenceLookup.entries()) {
      var _this$precedenceLooku;
      var orderPrecedence = (_this$precedenceLooku = this.precedenceLookup.get(condition)) !== null && _this$precedenceLooku !== void 0 ? _this$precedenceLooku : /* @__PURE__ */ new Set();
      this.precedenceLookup.set(condition, /* @__PURE__ */ new Set([...orderPrecedence, ...incomingOrderPrecedence]));
    }
  }
  /**
   * Merge another ConditionalRuleset into this one if they are compatible
   *
   * @returns true if successful, false if the ruleset is incompatible
   */
  mergeIfCompatible(incomingRuleset) {
    if (!this.isCompatible(incomingRuleset)) {
      return false;
    }
    this.merge(incomingRuleset);
    return true;
  }
  getSortedRuleset() {
    var _this = this;
    var sortedRuleset = [];
    var _loop = function _loop2(dependents2) {
      var conditionForQuery = _this.ruleset.get(query);
      if (!conditionForQuery) {
        throw new Error("Can't find condition for ".concat(query));
      }
      var firstMatchingDependent = sortedRuleset.findIndex((condition) => dependents2.has(condition.query));
      if (firstMatchingDependent > -1) {
        sortedRuleset.splice(firstMatchingDependent, 0, conditionForQuery);
      } else {
        sortedRuleset.push(conditionForQuery);
      }
    };
    for (var [query, dependents] of this.precedenceLookup.entries()) {
      _loop(dependents);
    }
    return sortedRuleset;
  }
  renderToArray() {
    var arr = [];
    for (var {
      query,
      rules,
      children
    } of this.getSortedRuleset()) {
      var selectors = {};
      for (var rule of rules) {
        selectors[rule.selector] = _objectSpread2(_objectSpread2({}, selectors[rule.selector]), rule.rule);
      }
      Object.assign(selectors, ...children.renderToArray());
      arr.push({
        [query]: selectors
      });
    }
    return arr;
  }
}
var simplePseudoMap = {
  ":-moz-any-link": true,
  ":-moz-full-screen": true,
  ":-moz-placeholder": true,
  ":-moz-read-only": true,
  ":-moz-read-write": true,
  ":-ms-fullscreen": true,
  ":-ms-input-placeholder": true,
  ":-webkit-any-link": true,
  ":-webkit-full-screen": true,
  "::-moz-color-swatch": true,
  "::-moz-list-bullet": true,
  "::-moz-list-number": true,
  "::-moz-page-sequence": true,
  "::-moz-page": true,
  "::-moz-placeholder": true,
  "::-moz-progress-bar": true,
  "::-moz-range-progress": true,
  "::-moz-range-thumb": true,
  "::-moz-range-track": true,
  "::-moz-scrolled-page-sequence": true,
  "::-moz-selection": true,
  "::-ms-backdrop": true,
  "::-ms-browse": true,
  "::-ms-check": true,
  "::-ms-clear": true,
  "::-ms-fill-lower": true,
  "::-ms-fill-upper": true,
  "::-ms-fill": true,
  "::-ms-reveal": true,
  "::-ms-thumb": true,
  "::-ms-ticks-after": true,
  "::-ms-ticks-before": true,
  "::-ms-tooltip": true,
  "::-ms-track": true,
  "::-ms-value": true,
  "::-webkit-backdrop": true,
  "::-webkit-calendar-picker-indicator": true,
  "::-webkit-inner-spin-button": true,
  "::-webkit-input-placeholder": true,
  "::-webkit-meter-bar": true,
  "::-webkit-meter-even-less-good-value": true,
  "::-webkit-meter-inner-element": true,
  "::-webkit-meter-optimum-value": true,
  "::-webkit-meter-suboptimum-value": true,
  "::-webkit-outer-spin-button": true,
  "::-webkit-progress-bar": true,
  "::-webkit-progress-inner-element": true,
  "::-webkit-progress-inner-value": true,
  "::-webkit-progress-value": true,
  "::-webkit-resizer": true,
  "::-webkit-scrollbar-button": true,
  "::-webkit-scrollbar-corner": true,
  "::-webkit-scrollbar-thumb": true,
  "::-webkit-scrollbar-track-piece": true,
  "::-webkit-scrollbar-track": true,
  "::-webkit-scrollbar": true,
  "::-webkit-search-cancel-button": true,
  "::-webkit-search-results-button": true,
  "::-webkit-slider-runnable-track": true,
  "::-webkit-slider-thumb": true,
  "::after": true,
  "::backdrop": true,
  "::before": true,
  "::cue": true,
  "::file-selector-button": true,
  "::first-letter": true,
  "::first-line": true,
  "::grammar-error": true,
  "::marker": true,
  "::placeholder": true,
  "::selection": true,
  "::spelling-error": true,
  "::target-text": true,
  "::view-transition-group": true,
  "::view-transition-image-pair": true,
  "::view-transition-new": true,
  "::view-transition-old": true,
  "::view-transition": true,
  ":active": true,
  ":after": true,
  ":any-link": true,
  ":before": true,
  ":blank": true,
  ":checked": true,
  ":default": true,
  ":defined": true,
  ":disabled": true,
  ":empty": true,
  ":enabled": true,
  ":first-child": true,
  ":first-letter": true,
  ":first-line": true,
  ":first-of-type": true,
  ":first": true,
  ":focus-visible": true,
  ":focus-within": true,
  ":focus": true,
  ":fullscreen": true,
  ":hover": true,
  ":in-range": true,
  ":indeterminate": true,
  ":invalid": true,
  ":last-child": true,
  ":last-of-type": true,
  ":left": true,
  ":link": true,
  ":only-child": true,
  ":only-of-type": true,
  ":optional": true,
  ":out-of-range": true,
  ":placeholder-shown": true,
  ":read-only": true,
  ":read-write": true,
  ":required": true,
  ":right": true,
  ":root": true,
  ":scope": true,
  ":target": true,
  ":valid": true,
  ":visited": true
};
var simplePseudos = Object.keys(simplePseudoMap);
var simplePseudoLookup = simplePseudoMap;
var _templateObject$2;
var createMediaQueryError = (mediaQuery, msg) => new Error(dedent(_templateObject$2 || (_templateObject$2 = _taggedTemplateLiteral(['\n    Invalid media query: "', '"\n\n    ', "\n\n    Read more on MDN: https://developer.mozilla.org/en-US/docs/Web/CSS/Media_Queries/Using_media_queries\n  "])), mediaQuery, msg));
var validateMediaQuery = (mediaQuery) => {
  if (mediaQuery === "@media ") {
    throw createMediaQueryError(mediaQuery, "Query is empty");
  }
  try {
    toAST2(mediaQuery);
  } catch (e) {
    throw createMediaQueryError(mediaQuery, e.message);
  }
};
var _excluded = ["vars"], _excluded2 = ["content"];
var DECLARATION = "__DECLARATION";
var UNITLESS = {
  animationIterationCount: true,
  borderImage: true,
  borderImageOutset: true,
  borderImageSlice: true,
  borderImageWidth: true,
  boxFlex: true,
  boxFlexGroup: true,
  columnCount: true,
  columns: true,
  flex: true,
  flexGrow: true,
  flexShrink: true,
  fontWeight: true,
  gridArea: true,
  gridColumn: true,
  gridColumnEnd: true,
  gridColumnStart: true,
  gridRow: true,
  gridRowEnd: true,
  gridRowStart: true,
  initialLetter: true,
  lineClamp: true,
  lineHeight: true,
  maxLines: true,
  opacity: true,
  order: true,
  orphans: true,
  scale: true,
  tabSize: true,
  WebkitLineClamp: true,
  widows: true,
  zIndex: true,
  zoom: true,
  // svg properties
  fillOpacity: true,
  floodOpacity: true,
  maskBorder: true,
  maskBorderOutset: true,
  maskBorderSlice: true,
  maskBorderWidth: true,
  shapeImageThreshold: true,
  stopOpacity: true,
  strokeDashoffset: true,
  strokeMiterlimit: true,
  strokeOpacity: true,
  strokeWidth: true
};
function dashify(str) {
  return str.replace(/([A-Z])/g, "-$1").replace(/^ms-/, "-ms-").toLowerCase();
}
function replaceBetweenIndexes(target, startIndex, endIndex, replacement) {
  var start = target.slice(0, startIndex);
  var end = target.slice(endIndex);
  return "".concat(start).concat(replacement).concat(end);
}
var DOUBLE_SPACE = "  ";
var specialKeys = [...simplePseudos, "@layer", "@media", "@supports", "@container", "selectors"];
class Stylesheet2 {
  constructor(localClassNames2, composedClassLists2) {
    this.rules = [];
    this.conditionalRulesets = [new ConditionalRuleset2()];
    this.fontFaceRules = [];
    this.keyframesRules = [];
    this.propertyRules = [];
    this.localClassNamesMap = new Map(localClassNames2.map((localClassName) => [localClassName, localClassName]));
    this.localClassNamesSearch = new AhoCorasick2(localClassNames2);
    this.layers = /* @__PURE__ */ new Map();
    this.composedClassLists = composedClassLists2.map((_ref) => {
      var {
        identifier,
        classList
      } = _ref;
      return {
        identifier,
        regex: RegExp("(".concat(classList, ")"), "g")
      };
    }).reverse();
  }
  processCssObj(root) {
    if (root.type === "fontFace") {
      this.fontFaceRules.push(root.rule);
      return;
    }
    if (root.type === "property") {
      this.propertyRules.push(root);
      return;
    }
    if (root.type === "keyframes") {
      root.rule = Object.fromEntries(Object.entries(root.rule).map((_ref2) => {
        var [keyframe, rule] = _ref2;
        return [keyframe, this.transformVars(this.transformProperties(rule))];
      }));
      this.keyframesRules.push(root);
      return;
    }
    this.currConditionalRuleset = new ConditionalRuleset2();
    if (root.type === "layer") {
      var layerDefinition = "@layer ".concat(root.name);
      this.addLayer([layerDefinition]);
    } else {
      var mainRule = omit(root.rule, specialKeys);
      this.addRule({
        selector: root.selector,
        rule: mainRule
      });
      this.transformLayer(root, root.rule["@layer"]);
      this.transformMedia(root, root.rule["@media"]);
      this.transformSupports(root, root.rule["@supports"]);
      this.transformContainer(root, root.rule["@container"]);
      this.transformSimplePseudos(root, root.rule);
      this.transformSelectors(root, root.rule);
    }
    var activeConditionalRuleset = this.conditionalRulesets[this.conditionalRulesets.length - 1];
    if (!activeConditionalRuleset.mergeIfCompatible(this.currConditionalRuleset)) {
      this.conditionalRulesets.push(this.currConditionalRuleset);
    }
  }
  addConditionalRule(cssRule, conditions) {
    var rule = this.transformVars(this.transformProperties(cssRule.rule));
    var selector = this.transformSelector(cssRule.selector);
    if (!this.currConditionalRuleset) {
      throw new Error("Couldn't add conditional rule");
    }
    var conditionQuery = conditions[conditions.length - 1];
    var parentConditions = conditions.slice(0, conditions.length - 1);
    this.currConditionalRuleset.addRule({
      selector,
      rule
    }, conditionQuery, parentConditions);
  }
  addRule(cssRule) {
    var rule = this.transformVars(this.transformProperties(cssRule.rule));
    var selector = this.transformSelector(cssRule.selector);
    this.rules.push({
      selector,
      rule
    });
  }
  addLayer(layer) {
    var uniqueLayerKey = layer.join(" - ");
    this.layers.set(uniqueLayerKey, layer);
  }
  transformProperties(cssRule) {
    return this.transformContent(this.pixelifyProperties(cssRule));
  }
  pixelifyProperties(cssRule) {
    forEach(cssRule, (value, key) => {
      if (typeof value === "number" && value !== 0 && !UNITLESS[key]) {
        cssRule[key] = "".concat(value, "px");
      }
    });
    return cssRule;
  }
  transformVars(_ref3) {
    var {
      vars
    } = _ref3, rest = _objectWithoutProperties(_ref3, _excluded);
    if (!vars) {
      return rest;
    }
    return _objectSpread2(_objectSpread2({}, mapKeys(vars, (_value, key) => getVarName$1(key))), rest);
  }
  transformContent(_ref4) {
    var {
      content
    } = _ref4, rest = _objectWithoutProperties(_ref4, _excluded2);
    if (typeof content === "undefined") {
      return rest;
    }
    var contentArray = Array.isArray(content) ? content : [content];
    return _objectSpread2({
      content: contentArray.map((value) => (
        // This logic was adapted from Stitches :)
        value && (value.includes('"') || value.includes("'") || /^([A-Za-z\-]+\([^]*|[^]*-quote|inherit|initial|none|normal|revert|unset)(\s|$)/.test(value)) ? value : '"'.concat(value, '"')
      ))
    }, rest);
  }
  transformClassname(identifier) {
    return ".".concat(cssesc(identifier, {
      isIdentifier: true
    }));
  }
  transformSelector(selector) {
    var transformedSelector = selector;
    var _loop = function _loop2(identifier2) {
      transformedSelector = transformedSelector.replace(regex, () => {
        markCompositionUsed2(identifier2);
        return identifier2;
      });
    };
    for (var {
      identifier,
      regex
    } of this.composedClassLists) {
      _loop(identifier);
    }
    if (this.localClassNamesMap.has(transformedSelector)) {
      return this.transformClassname(transformedSelector);
    }
    var results = this.localClassNamesSearch.search(transformedSelector);
    var lastReplaceIndex = transformedSelector.length;
    for (var i = results.length - 1; i >= 0; i--) {
      var [endIndex, [firstMatch]] = results[i];
      var startIndex = endIndex - firstMatch.length + 1;
      var skipReplacement = lastReplaceIndex <= endIndex;
      if (skipReplacement) {
        continue;
      }
      lastReplaceIndex = startIndex;
      if (transformedSelector[startIndex - 1] !== ".") {
        transformedSelector = replaceBetweenIndexes(transformedSelector, startIndex, endIndex + 1, this.transformClassname(firstMatch));
      }
    }
    return transformedSelector;
  }
  transformSelectors(root, rule, conditions) {
    forEach(rule.selectors, (selectorRule, selector) => {
      if (root.type !== "local") {
        throw new Error("Selectors are not allowed within ".concat(root.type === "global" ? '"globalStyle"' : '"selectors"'));
      }
      var transformedSelector = this.transformSelector(selector.replace(RegExp("&", "g"), root.selector));
      validateSelector(transformedSelector, root.selector);
      var rule2 = {
        selector: transformedSelector,
        rule: omit(selectorRule, specialKeys)
      };
      if (conditions) {
        this.addConditionalRule(rule2, conditions);
      } else {
        this.addRule(rule2);
      }
      var selectorRoot = {
        type: "selector",
        selector: transformedSelector,
        rule: selectorRule
      };
      this.transformLayer(selectorRoot, selectorRule["@layer"], conditions);
      this.transformSupports(selectorRoot, selectorRule["@supports"], conditions);
      this.transformMedia(selectorRoot, selectorRule["@media"], conditions);
      this.transformContainer(selectorRoot, selectorRule["@container"], conditions);
    });
  }
  transformMedia(root, rules) {
    var parentConditions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
    if (rules) {
      var _this$currConditional;
      (_this$currConditional = this.currConditionalRuleset) === null || _this$currConditional === void 0 || _this$currConditional.addConditionPrecedence(parentConditions, Object.keys(rules).map((query2) => "@media ".concat(query2)));
      for (var [query, mediaRule] of Object.entries(rules)) {
        var mediaQuery = "@media ".concat(query);
        validateMediaQuery(mediaQuery);
        var conditions = [...parentConditions, mediaQuery];
        this.addConditionalRule({
          selector: root.selector,
          rule: omit(mediaRule, specialKeys)
        }, conditions);
        if (root.type === "local") {
          this.transformSimplePseudos(root, mediaRule, conditions);
          this.transformSelectors(root, mediaRule, conditions);
        }
        this.transformLayer(root, mediaRule["@layer"], conditions);
        this.transformSupports(root, mediaRule["@supports"], conditions);
        this.transformContainer(root, mediaRule["@container"], conditions);
      }
    }
  }
  transformContainer(root, rules) {
    var parentConditions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
    if (rules) {
      var _this$currConditional2;
      (_this$currConditional2 = this.currConditionalRuleset) === null || _this$currConditional2 === void 0 || _this$currConditional2.addConditionPrecedence(parentConditions, Object.keys(rules).map((query) => "@container ".concat(query)));
      forEach(rules, (containerRule, query) => {
        var containerQuery = "@container ".concat(query);
        var conditions = [...parentConditions, containerQuery];
        this.addConditionalRule({
          selector: root.selector,
          rule: omit(containerRule, specialKeys)
        }, conditions);
        if (root.type === "local") {
          this.transformSimplePseudos(root, containerRule, conditions);
          this.transformSelectors(root, containerRule, conditions);
        }
        this.transformLayer(root, containerRule["@layer"], conditions);
        this.transformSupports(root, containerRule["@supports"], conditions);
        this.transformMedia(root, containerRule["@media"], conditions);
      });
    }
  }
  transformLayer(root, rules) {
    var parentConditions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
    if (rules) {
      var _this$currConditional3;
      (_this$currConditional3 = this.currConditionalRuleset) === null || _this$currConditional3 === void 0 || _this$currConditional3.addConditionPrecedence(parentConditions, Object.keys(rules).map((name) => "@layer ".concat(name)));
      forEach(rules, (layerRule, name) => {
        var conditions = [...parentConditions, "@layer ".concat(name)];
        this.addLayer(conditions);
        this.addConditionalRule({
          selector: root.selector,
          rule: omit(layerRule, specialKeys)
        }, conditions);
        if (root.type === "local") {
          this.transformSimplePseudos(root, layerRule, conditions);
          this.transformSelectors(root, layerRule, conditions);
        }
        this.transformMedia(root, layerRule["@media"], conditions);
        this.transformSupports(root, layerRule["@supports"], conditions);
        this.transformContainer(root, layerRule["@container"], conditions);
      });
    }
  }
  transformSupports(root, rules) {
    var parentConditions = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
    if (rules) {
      var _this$currConditional4;
      (_this$currConditional4 = this.currConditionalRuleset) === null || _this$currConditional4 === void 0 || _this$currConditional4.addConditionPrecedence(parentConditions, Object.keys(rules).map((query) => "@supports ".concat(query)));
      forEach(rules, (supportsRule, query) => {
        var conditions = [...parentConditions, "@supports ".concat(query)];
        this.addConditionalRule({
          selector: root.selector,
          rule: omit(supportsRule, specialKeys)
        }, conditions);
        if (root.type === "local") {
          this.transformSimplePseudos(root, supportsRule, conditions);
          this.transformSelectors(root, supportsRule, conditions);
        }
        this.transformLayer(root, supportsRule["@layer"], conditions);
        this.transformMedia(root, supportsRule["@media"], conditions);
        this.transformContainer(root, supportsRule["@container"], conditions);
      });
    }
  }
  transformSimplePseudos(root, rule, conditions) {
    for (var key of Object.keys(rule)) {
      if (simplePseudoLookup[key]) {
        if (root.type !== "local") {
          throw new Error("Simple pseudos are not valid in ".concat(root.type === "global" ? '"globalStyle"' : '"selectors"'));
        }
        if (conditions) {
          this.addConditionalRule({
            selector: "".concat(root.selector).concat(key),
            rule: rule[key]
          }, conditions);
        } else {
          this.addRule({
            conditions,
            selector: "".concat(root.selector).concat(key),
            rule: rule[key]
          });
        }
      }
    }
  }
  toCss() {
    var css2 = [];
    for (var fontFaceRule of this.fontFaceRules) {
      css2.push(renderCss({
        "@font-face": fontFaceRule
      }));
    }
    for (var property of this.propertyRules) {
      css2.push(renderCss({
        ["@property ".concat(property.name)]: property.rule
      }));
    }
    for (var keyframe of this.keyframesRules) {
      css2.push(renderCss({
        ["@keyframes ".concat(keyframe.name)]: keyframe.rule
      }));
    }
    for (var layer of this.layers.values()) {
      var [definition, ...nesting] = layer.reverse();
      var cssObj = {
        [definition]: DECLARATION
      };
      for (var part of nesting) {
        cssObj = {
          [part]: cssObj
        };
      }
      css2.push(renderCss(cssObj));
    }
    for (var rule of this.rules) {
      css2.push(renderCss({
        [rule.selector]: rule.rule
      }));
    }
    for (var conditionalRuleset of this.conditionalRulesets) {
      for (var conditionalRule of conditionalRuleset.renderToArray()) {
        css2.push(renderCss(conditionalRule));
      }
    }
    return css2.filter(Boolean);
  }
}
function renderCss(v) {
  var indent = arguments.length > 1 && arguments[1] !== void 0 ? arguments[1] : "";
  var rules = [];
  var _loop2 = function _loop22(key2) {
    var value = v[key2];
    if (value && Array.isArray(value)) {
      rules.push(...value.map((v2) => renderCss({
        [key2]: v2
      }, indent)));
    } else if (value && typeof value === "object") {
      var isEmpty = Object.keys(value).length === 0;
      if (!isEmpty) {
        rules.push("".concat(indent).concat(key2, " {\n").concat(renderCss(value, indent + DOUBLE_SPACE), "\n").concat(indent, "}"));
      }
    } else if (value === DECLARATION) {
      rules.push("".concat(indent).concat(key2, ";"));
    } else {
      rules.push("".concat(indent).concat(key2.startsWith("--") ? key2 : dashify(key2), ": ").concat(value, ";"));
    }
  };
  for (var key of Object.keys(v)) {
    _loop2(key);
  }
  return rules.join("\n");
}
function transformCss(_ref5) {
  var {
    localClassNames: localClassNames2,
    cssObjs,
    composedClassLists: composedClassLists2
  } = _ref5;
  var stylesheet = new Stylesheet2(localClassNames2, composedClassLists2);
  for (var root of cssObjs) {
    stylesheet.processCssObj(root);
  }
  return stylesheet.toCss();
}
function murmur2(str) {
  var h = 0;
  var k, i = 0, len = str.length;
  for (; len >= 4; ++i, len -= 4) {
    k = str.charCodeAt(i) & 255 | (str.charCodeAt(++i) & 255) << 8 | (str.charCodeAt(++i) & 255) << 16 | (str.charCodeAt(++i) & 255) << 24;
    k = /* Math.imul(k, m): */
    (k & 65535) * 1540483477 + ((k >>> 16) * 59797 << 16);
    k ^= /* k >>> r: */
    k >>> 24;
    h = /* Math.imul(k, m): */
    (k & 65535) * 1540483477 + ((k >>> 16) * 59797 << 16) ^ /* Math.imul(h, m): */
    (h & 65535) * 1540483477 + ((h >>> 16) * 59797 << 16);
  }
  switch (len) {
    case 3:
      h ^= (str.charCodeAt(i + 2) & 255) << 16;
    case 2:
      h ^= (str.charCodeAt(i + 1) & 255) << 8;
    case 1:
      h ^= str.charCodeAt(i) & 255;
      h = /* Math.imul(h, m): */
      (h & 65535) * 1540483477 + ((h >>> 16) * 59797 << 16);
  }
  h ^= h >>> 13;
  h = /* Math.imul(h, m): */
  (h & 65535) * 1540483477 + ((h >>> 16) * 59797 << 16);
  return ((h ^ h >>> 15) >>> 0).toString(36);
}
var _templateObject$1;
var refCounter = 0;
var fileScopes = [];
function getFileScope() {
  if (fileScopes.length === 0) {
    throw new Error(dedent(_templateObject$1 || (_templateObject$1 = _taggedTemplateLiteral(["\n        Styles were unable to be assigned to a file. This is generally caused by one of the following:\n\n        - You may have created styles outside of a '.css.ts' context\n        - You may have incorrect configuration. See https://vanilla-extract.style/documentation/getting-started\n      "]))));
  }
  return fileScopes[0];
}
function getAndIncrementRefCounter() {
  return refCounter++;
}
const perf = typeof performance === "object" && performance && typeof performance.now === "function" ? performance : Date;
const warned = /* @__PURE__ */ new Set();
const PROCESS = typeof process === "object" && !!process ? process : {};
const emitWarning = (msg, type, code, fn) => {
  typeof PROCESS.emitWarning === "function" ? PROCESS.emitWarning(msg, type, code, fn) : console.error(`[${code}] ${type}: ${msg}`);
};
let AC = globalThis.AbortController;
let AS = globalThis.AbortSignal;
if (typeof AC === "undefined") {
  AS = class AbortSignal {
    constructor() {
      __publicField(this, "onabort");
      __publicField(this, "_onabort", []);
      __publicField(this, "reason");
      __publicField(this, "aborted", false);
    }
    addEventListener(_, fn) {
      this._onabort.push(fn);
    }
  };
  AC = class AbortController {
    constructor() {
      __publicField(this, "signal", new AS());
      warnACPolyfill();
    }
    abort(reason) {
      if (this.signal.aborted)
        return;
      this.signal.reason = reason;
      this.signal.aborted = true;
      for (const fn of this.signal._onabort) {
        fn(reason);
      }
      this.signal.onabort?.(reason);
    }
  };
  let printACPolyfillWarning = PROCESS.env?.LRU_CACHE_IGNORE_AC_WARNING !== "1";
  const warnACPolyfill = () => {
    if (!printACPolyfillWarning)
      return;
    printACPolyfillWarning = false;
    emitWarning("AbortController is not defined. If using lru-cache in node 14, load an AbortController polyfill from the `node-abort-controller` package. A minimal polyfill is provided for use by LRUCache.fetch(), but it should not be relied upon in other contexts (eg, passing it to other APIs that use AbortController/AbortSignal might have undesirable effects). You may disable this with LRU_CACHE_IGNORE_AC_WARNING=1 in the env.", "NO_ABORT_CONTROLLER", "ENOTSUP", warnACPolyfill);
  };
}
const shouldWarn = (code) => !warned.has(code);
const isPosInt = (n) => n && n === Math.floor(n) && n > 0 && isFinite(n);
const getUintArray = (max) => !isPosInt(max) ? null : max <= Math.pow(2, 8) ? Uint8Array : max <= Math.pow(2, 16) ? Uint16Array : max <= Math.pow(2, 32) ? Uint32Array : max <= Number.MAX_SAFE_INTEGER ? ZeroArray2 : null;
class ZeroArray2 extends Array {
  constructor(size) {
    super(size);
    this.fill(0);
  }
}
const _Stack = class _Stack2 {
  constructor(max, HeapCls) {
    __publicField(this, "heap");
    __publicField(this, "length");
    if (!__privateGet(_Stack2, _constructing)) {
      throw new TypeError("instantiate Stack using Stack.create(n)");
    }
    this.heap = new HeapCls(max);
    this.length = 0;
  }
  static create(max) {
    const HeapCls = getUintArray(max);
    if (!HeapCls)
      return [];
    __privateSet(_Stack2, _constructing, true);
    const s = new _Stack2(max, HeapCls);
    __privateSet(_Stack2, _constructing, false);
    return s;
  }
  push(n) {
    this.heap[this.length++] = n;
  }
  pop() {
    return this.heap[--this.length];
  }
};
_constructing = /* @__PURE__ */ new WeakMap();
__privateAdd(_Stack, _constructing, false);
let Stack2 = _Stack;
const _LRUCache = class _LRUCache2 {
  constructor(options) {
    __privateAdd(this, _LRUCache_instances);
    __privateAdd(this, _max);
    __privateAdd(this, _maxSize);
    __privateAdd(this, _dispose);
    __privateAdd(this, _disposeAfter);
    __privateAdd(this, _fetchMethod);
    __privateAdd(this, _memoMethod);
    __publicField(this, "ttl");
    __publicField(this, "ttlResolution");
    __publicField(this, "ttlAutopurge");
    __publicField(this, "updateAgeOnGet");
    __publicField(this, "updateAgeOnHas");
    __publicField(this, "allowStale");
    __publicField(this, "noDisposeOnSet");
    __publicField(this, "noUpdateTTL");
    __publicField(this, "maxEntrySize");
    __publicField(this, "sizeCalculation");
    __publicField(this, "noDeleteOnFetchRejection");
    __publicField(this, "noDeleteOnStaleGet");
    __publicField(this, "allowStaleOnFetchAbort");
    __publicField(this, "allowStaleOnFetchRejection");
    __publicField(this, "ignoreFetchAbort");
    __privateAdd(this, _size);
    __privateAdd(this, _calculatedSize);
    __privateAdd(this, _keyMap);
    __privateAdd(this, _keyList);
    __privateAdd(this, _valList);
    __privateAdd(this, _next);
    __privateAdd(this, _prev);
    __privateAdd(this, _head);
    __privateAdd(this, _tail);
    __privateAdd(this, _free);
    __privateAdd(this, _disposed);
    __privateAdd(this, _sizes);
    __privateAdd(this, _starts);
    __privateAdd(this, _ttls);
    __privateAdd(this, _hasDispose);
    __privateAdd(this, _hasFetchMethod);
    __privateAdd(this, _hasDisposeAfter);
    __privateAdd(this, _updateItemAge, () => {
    });
    __privateAdd(this, _statusTTL, () => {
    });
    __privateAdd(this, _setItemTTL, () => {
    });
    __privateAdd(this, _isStale, () => false);
    __privateAdd(this, _removeItemSize, (_i) => {
    });
    __privateAdd(this, _addItemSize, (_i, _s, _st) => {
    });
    __privateAdd(this, _requireSize, (_k, _v, size, sizeCalculation2) => {
      if (size || sizeCalculation2) {
        throw new TypeError("cannot set size without setting maxSize or maxEntrySize on cache");
      }
      return 0;
    });
    __publicField(this, _a, "LRUCache");
    const { max = 0, ttl, ttlResolution = 1, ttlAutopurge, updateAgeOnGet, updateAgeOnHas, allowStale, dispose, disposeAfter, noDisposeOnSet, noUpdateTTL, maxSize = 0, maxEntrySize = 0, sizeCalculation, fetchMethod, memoMethod, noDeleteOnFetchRejection, noDeleteOnStaleGet, allowStaleOnFetchRejection, allowStaleOnFetchAbort, ignoreFetchAbort } = options;
    if (max !== 0 && !isPosInt(max)) {
      throw new TypeError("max option must be a nonnegative integer");
    }
    const UintArray = max ? getUintArray(max) : Array;
    if (!UintArray) {
      throw new Error("invalid max value: " + max);
    }
    __privateSet(this, _max, max);
    __privateSet(this, _maxSize, maxSize);
    this.maxEntrySize = maxEntrySize || __privateGet(this, _maxSize);
    this.sizeCalculation = sizeCalculation;
    if (this.sizeCalculation) {
      if (!__privateGet(this, _maxSize) && !this.maxEntrySize) {
        throw new TypeError("cannot set sizeCalculation without setting maxSize or maxEntrySize");
      }
      if (typeof this.sizeCalculation !== "function") {
        throw new TypeError("sizeCalculation set to non-function");
      }
    }
    if (memoMethod !== void 0 && typeof memoMethod !== "function") {
      throw new TypeError("memoMethod must be a function if defined");
    }
    __privateSet(this, _memoMethod, memoMethod);
    if (fetchMethod !== void 0 && typeof fetchMethod !== "function") {
      throw new TypeError("fetchMethod must be a function if specified");
    }
    __privateSet(this, _fetchMethod, fetchMethod);
    __privateSet(this, _hasFetchMethod, !!fetchMethod);
    __privateSet(this, _keyMap, /* @__PURE__ */ new Map());
    __privateSet(this, _keyList, new Array(max).fill(void 0));
    __privateSet(this, _valList, new Array(max).fill(void 0));
    __privateSet(this, _next, new UintArray(max));
    __privateSet(this, _prev, new UintArray(max));
    __privateSet(this, _head, 0);
    __privateSet(this, _tail, 0);
    __privateSet(this, _free, Stack2.create(max));
    __privateSet(this, _size, 0);
    __privateSet(this, _calculatedSize, 0);
    if (typeof dispose === "function") {
      __privateSet(this, _dispose, dispose);
    }
    if (typeof disposeAfter === "function") {
      __privateSet(this, _disposeAfter, disposeAfter);
      __privateSet(this, _disposed, []);
    } else {
      __privateSet(this, _disposeAfter, void 0);
      __privateSet(this, _disposed, void 0);
    }
    __privateSet(this, _hasDispose, !!__privateGet(this, _dispose));
    __privateSet(this, _hasDisposeAfter, !!__privateGet(this, _disposeAfter));
    this.noDisposeOnSet = !!noDisposeOnSet;
    this.noUpdateTTL = !!noUpdateTTL;
    this.noDeleteOnFetchRejection = !!noDeleteOnFetchRejection;
    this.allowStaleOnFetchRejection = !!allowStaleOnFetchRejection;
    this.allowStaleOnFetchAbort = !!allowStaleOnFetchAbort;
    this.ignoreFetchAbort = !!ignoreFetchAbort;
    if (this.maxEntrySize !== 0) {
      if (__privateGet(this, _maxSize) !== 0) {
        if (!isPosInt(__privateGet(this, _maxSize))) {
          throw new TypeError("maxSize must be a positive integer if specified");
        }
      }
      if (!isPosInt(this.maxEntrySize)) {
        throw new TypeError("maxEntrySize must be a positive integer if specified");
      }
      __privateMethod(this, _LRUCache_instances, initializeSizeTracking_fn).call(this);
    }
    this.allowStale = !!allowStale;
    this.noDeleteOnStaleGet = !!noDeleteOnStaleGet;
    this.updateAgeOnGet = !!updateAgeOnGet;
    this.updateAgeOnHas = !!updateAgeOnHas;
    this.ttlResolution = isPosInt(ttlResolution) || ttlResolution === 0 ? ttlResolution : 1;
    this.ttlAutopurge = !!ttlAutopurge;
    this.ttl = ttl || 0;
    if (this.ttl) {
      if (!isPosInt(this.ttl)) {
        throw new TypeError("ttl must be a positive integer if specified");
      }
      __privateMethod(this, _LRUCache_instances, initializeTTLTracking_fn).call(this);
    }
    if (__privateGet(this, _max) === 0 && this.ttl === 0 && __privateGet(this, _maxSize) === 0) {
      throw new TypeError("At least one of max, maxSize, or ttl is required");
    }
    if (!this.ttlAutopurge && !__privateGet(this, _max) && !__privateGet(this, _maxSize)) {
      const code = "LRU_CACHE_UNBOUNDED";
      if (shouldWarn(code)) {
        warned.add(code);
        const msg = "TTL caching without ttlAutopurge, max, or maxSize can result in unbounded memory consumption.";
        emitWarning(msg, "UnboundedCacheWarning", code, _LRUCache2);
      }
    }
  }
  /**
   * Do not call this method unless you need to inspect the
   * inner workings of the cache.  If anything returned by this
   * object is modified in any way, strange breakage may occur.
   *
   * These fields are private for a reason!
   *
   * @internal
   */
  static unsafeExposeInternals(c) {
    return {
      // properties
      starts: __privateGet(c, _starts),
      ttls: __privateGet(c, _ttls),
      sizes: __privateGet(c, _sizes),
      keyMap: __privateGet(c, _keyMap),
      keyList: __privateGet(c, _keyList),
      valList: __privateGet(c, _valList),
      next: __privateGet(c, _next),
      prev: __privateGet(c, _prev),
      get head() {
        return __privateGet(c, _head);
      },
      get tail() {
        return __privateGet(c, _tail);
      },
      free: __privateGet(c, _free),
      // methods
      isBackgroundFetch: (p) => {
        var _a2;
        return __privateMethod(_a2 = c, _LRUCache_instances, isBackgroundFetch_fn).call(_a2, p);
      },
      backgroundFetch: (k, index, options, context) => {
        var _a2;
        return __privateMethod(_a2 = c, _LRUCache_instances, backgroundFetch_fn).call(_a2, k, index, options, context);
      },
      moveToTail: (index) => {
        var _a2;
        return __privateMethod(_a2 = c, _LRUCache_instances, moveToTail_fn).call(_a2, index);
      },
      indexes: (options) => {
        var _a2;
        return __privateMethod(_a2 = c, _LRUCache_instances, indexes_fn).call(_a2, options);
      },
      rindexes: (options) => {
        var _a2;
        return __privateMethod(_a2 = c, _LRUCache_instances, rindexes_fn).call(_a2, options);
      },
      isStale: (index) => {
        var _a2;
        return __privateGet(_a2 = c, _isStale).call(_a2, index);
      }
    };
  }
  // Protected read-only members
  /**
   * {@link LRUCache.OptionsBase.max} (read-only)
   */
  get max() {
    return __privateGet(this, _max);
  }
  /**
   * {@link LRUCache.OptionsBase.maxSize} (read-only)
   */
  get maxSize() {
    return __privateGet(this, _maxSize);
  }
  /**
   * The total computed size of items in the cache (read-only)
   */
  get calculatedSize() {
    return __privateGet(this, _calculatedSize);
  }
  /**
   * The number of items stored in the cache (read-only)
   */
  get size() {
    return __privateGet(this, _size);
  }
  /**
   * {@link LRUCache.OptionsBase.fetchMethod} (read-only)
   */
  get fetchMethod() {
    return __privateGet(this, _fetchMethod);
  }
  get memoMethod() {
    return __privateGet(this, _memoMethod);
  }
  /**
   * {@link LRUCache.OptionsBase.dispose} (read-only)
   */
  get dispose() {
    return __privateGet(this, _dispose);
  }
  /**
   * {@link LRUCache.OptionsBase.disposeAfter} (read-only)
   */
  get disposeAfter() {
    return __privateGet(this, _disposeAfter);
  }
  /**
   * Return the number of ms left in the item's TTL. If item is not in cache,
   * returns `0`. Returns `Infinity` if item is in cache without a defined TTL.
   */
  getRemainingTTL(key) {
    return __privateGet(this, _keyMap).has(key) ? Infinity : 0;
  }
  /**
   * Return a generator yielding `[key, value]` pairs,
   * in order from most recently used to least recently used.
   */
  *entries() {
    for (const i of __privateMethod(this, _LRUCache_instances, indexes_fn).call(this)) {
      if (__privateGet(this, _valList)[i] !== void 0 && __privateGet(this, _keyList)[i] !== void 0 && !__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, __privateGet(this, _valList)[i])) {
        yield [__privateGet(this, _keyList)[i], __privateGet(this, _valList)[i]];
      }
    }
  }
  /**
   * Inverse order version of {@link LRUCache.entries}
   *
   * Return a generator yielding `[key, value]` pairs,
   * in order from least recently used to most recently used.
   */
  *rentries() {
    for (const i of __privateMethod(this, _LRUCache_instances, rindexes_fn).call(this)) {
      if (__privateGet(this, _valList)[i] !== void 0 && __privateGet(this, _keyList)[i] !== void 0 && !__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, __privateGet(this, _valList)[i])) {
        yield [__privateGet(this, _keyList)[i], __privateGet(this, _valList)[i]];
      }
    }
  }
  /**
   * Return a generator yielding the keys in the cache,
   * in order from most recently used to least recently used.
   */
  *keys() {
    for (const i of __privateMethod(this, _LRUCache_instances, indexes_fn).call(this)) {
      const k = __privateGet(this, _keyList)[i];
      if (k !== void 0 && !__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, __privateGet(this, _valList)[i])) {
        yield k;
      }
    }
  }
  /**
   * Inverse order version of {@link LRUCache.keys}
   *
   * Return a generator yielding the keys in the cache,
   * in order from least recently used to most recently used.
   */
  *rkeys() {
    for (const i of __privateMethod(this, _LRUCache_instances, rindexes_fn).call(this)) {
      const k = __privateGet(this, _keyList)[i];
      if (k !== void 0 && !__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, __privateGet(this, _valList)[i])) {
        yield k;
      }
    }
  }
  /**
   * Return a generator yielding the values in the cache,
   * in order from most recently used to least recently used.
   */
  *values() {
    for (const i of __privateMethod(this, _LRUCache_instances, indexes_fn).call(this)) {
      const v = __privateGet(this, _valList)[i];
      if (v !== void 0 && !__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, __privateGet(this, _valList)[i])) {
        yield __privateGet(this, _valList)[i];
      }
    }
  }
  /**
   * Inverse order version of {@link LRUCache.values}
   *
   * Return a generator yielding the values in the cache,
   * in order from least recently used to most recently used.
   */
  *rvalues() {
    for (const i of __privateMethod(this, _LRUCache_instances, rindexes_fn).call(this)) {
      const v = __privateGet(this, _valList)[i];
      if (v !== void 0 && !__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, __privateGet(this, _valList)[i])) {
        yield __privateGet(this, _valList)[i];
      }
    }
  }
  /**
   * Iterating over the cache itself yields the same results as
   * {@link LRUCache.entries}
   */
  [(_b = Symbol.iterator, _a = Symbol.toStringTag, _b)]() {
    return this.entries();
  }
  /**
   * Find a value for which the supplied fn method returns a truthy value,
   * similar to `Array.find()`. fn is called as `fn(value, key, cache)`.
   */
  find(fn, getOptions = {}) {
    for (const i of __privateMethod(this, _LRUCache_instances, indexes_fn).call(this)) {
      const v = __privateGet(this, _valList)[i];
      const value = __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v) ? v.__staleWhileFetching : v;
      if (value === void 0)
        continue;
      if (fn(value, __privateGet(this, _keyList)[i], this)) {
        return this.get(__privateGet(this, _keyList)[i], getOptions);
      }
    }
  }
  /**
   * Call the supplied function on each item in the cache, in order from most
   * recently used to least recently used.
   *
   * `fn` is called as `fn(value, key, cache)`.
   *
   * If `thisp` is provided, function will be called in the `this`-context of
   * the provided object, or the cache if no `thisp` object is provided.
   *
   * Does not update age or recenty of use, or iterate over stale values.
   */
  forEach(fn, thisp = this) {
    for (const i of __privateMethod(this, _LRUCache_instances, indexes_fn).call(this)) {
      const v = __privateGet(this, _valList)[i];
      const value = __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v) ? v.__staleWhileFetching : v;
      if (value === void 0)
        continue;
      fn.call(thisp, value, __privateGet(this, _keyList)[i], this);
    }
  }
  /**
   * The same as {@link LRUCache.forEach} but items are iterated over in
   * reverse order.  (ie, less recently used items are iterated over first.)
   */
  rforEach(fn, thisp = this) {
    for (const i of __privateMethod(this, _LRUCache_instances, rindexes_fn).call(this)) {
      const v = __privateGet(this, _valList)[i];
      const value = __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v) ? v.__staleWhileFetching : v;
      if (value === void 0)
        continue;
      fn.call(thisp, value, __privateGet(this, _keyList)[i], this);
    }
  }
  /**
   * Delete any stale entries. Returns true if anything was removed,
   * false otherwise.
   */
  purgeStale() {
    let deleted = false;
    for (const i of __privateMethod(this, _LRUCache_instances, rindexes_fn).call(this, { allowStale: true })) {
      if (__privateGet(this, _isStale).call(this, i)) {
        __privateMethod(this, _LRUCache_instances, delete_fn).call(this, __privateGet(this, _keyList)[i], "expire");
        deleted = true;
      }
    }
    return deleted;
  }
  /**
   * Get the extended info about a given entry, to get its value, size, and
   * TTL info simultaneously. Returns `undefined` if the key is not present.
   *
   * Unlike {@link LRUCache#dump}, which is designed to be portable and survive
   * serialization, the `start` value is always the current timestamp, and the
   * `ttl` is a calculated remaining time to live (negative if expired).
   *
   * Always returns stale values, if their info is found in the cache, so be
   * sure to check for expirations (ie, a negative {@link LRUCache.Entry#ttl})
   * if relevant.
   */
  info(key) {
    const i = __privateGet(this, _keyMap).get(key);
    if (i === void 0)
      return void 0;
    const v = __privateGet(this, _valList)[i];
    const value = __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v) ? v.__staleWhileFetching : v;
    if (value === void 0)
      return void 0;
    const entry = { value };
    if (__privateGet(this, _ttls) && __privateGet(this, _starts)) {
      const ttl = __privateGet(this, _ttls)[i];
      const start = __privateGet(this, _starts)[i];
      if (ttl && start) {
        const remain = ttl - (perf.now() - start);
        entry.ttl = remain;
        entry.start = Date.now();
      }
    }
    if (__privateGet(this, _sizes)) {
      entry.size = __privateGet(this, _sizes)[i];
    }
    return entry;
  }
  /**
   * Return an array of [key, {@link LRUCache.Entry}] tuples which can be
   * passed to {@link LRLUCache#load}.
   *
   * The `start` fields are calculated relative to a portable `Date.now()`
   * timestamp, even if `performance.now()` is available.
   *
   * Stale entries are always included in the `dump`, even if
   * {@link LRUCache.OptionsBase.allowStale} is false.
   *
   * Note: this returns an actual array, not a generator, so it can be more
   * easily passed around.
   */
  dump() {
    const arr = [];
    for (const i of __privateMethod(this, _LRUCache_instances, indexes_fn).call(this, { allowStale: true })) {
      const key = __privateGet(this, _keyList)[i];
      const v = __privateGet(this, _valList)[i];
      const value = __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v) ? v.__staleWhileFetching : v;
      if (value === void 0 || key === void 0)
        continue;
      const entry = { value };
      if (__privateGet(this, _ttls) && __privateGet(this, _starts)) {
        entry.ttl = __privateGet(this, _ttls)[i];
        const age = perf.now() - __privateGet(this, _starts)[i];
        entry.start = Math.floor(Date.now() - age);
      }
      if (__privateGet(this, _sizes)) {
        entry.size = __privateGet(this, _sizes)[i];
      }
      arr.unshift([key, entry]);
    }
    return arr;
  }
  /**
   * Reset the cache and load in the items in entries in the order listed.
   *
   * The shape of the resulting cache may be different if the same options are
   * not used in both caches.
   *
   * The `start` fields are assumed to be calculated relative to a portable
   * `Date.now()` timestamp, even if `performance.now()` is available.
   */
  load(arr) {
    this.clear();
    for (const [key, entry] of arr) {
      if (entry.start) {
        const age = Date.now() - entry.start;
        entry.start = perf.now() - age;
      }
      this.set(key, entry.value, entry);
    }
  }
  /**
   * Add a value to the cache.
   *
   * Note: if `undefined` is specified as a value, this is an alias for
   * {@link LRUCache#delete}
   *
   * Fields on the {@link LRUCache.SetOptions} options param will override
   * their corresponding values in the constructor options for the scope
   * of this single `set()` operation.
   *
   * If `start` is provided, then that will set the effective start
   * time for the TTL calculation. Note that this must be a previous
   * value of `performance.now()` if supported, or a previous value of
   * `Date.now()` if not.
   *
   * Options object may also include `size`, which will prevent
   * calling the `sizeCalculation` function and just use the specified
   * number if it is a positive integer, and `noDisposeOnSet` which
   * will prevent calling a `dispose` function in the case of
   * overwrites.
   *
   * If the `size` (or return value of `sizeCalculation`) for a given
   * entry is greater than `maxEntrySize`, then the item will not be
   * added to the cache.
   *
   * Will update the recency of the entry.
   *
   * If the value is `undefined`, then this is an alias for
   * `cache.delete(key)`. `undefined` is never stored in the cache.
   */
  set(k, v, setOptions = {}) {
    var _a2, _b2, _c;
    if (v === void 0) {
      this.delete(k);
      return this;
    }
    const { ttl = this.ttl, start, noDisposeOnSet = this.noDisposeOnSet, sizeCalculation = this.sizeCalculation, status } = setOptions;
    let { noUpdateTTL = this.noUpdateTTL } = setOptions;
    const size = __privateGet(this, _requireSize).call(this, k, v, setOptions.size || 0, sizeCalculation);
    if (this.maxEntrySize && size > this.maxEntrySize) {
      if (status) {
        status.set = "miss";
        status.maxEntrySizeExceeded = true;
      }
      __privateMethod(this, _LRUCache_instances, delete_fn).call(this, k, "set");
      return this;
    }
    let index = __privateGet(this, _size) === 0 ? void 0 : __privateGet(this, _keyMap).get(k);
    if (index === void 0) {
      index = __privateGet(this, _size) === 0 ? __privateGet(this, _tail) : __privateGet(this, _free).length !== 0 ? __privateGet(this, _free).pop() : __privateGet(this, _size) === __privateGet(this, _max) ? __privateMethod(this, _LRUCache_instances, evict_fn).call(this, false) : __privateGet(this, _size);
      __privateGet(this, _keyList)[index] = k;
      __privateGet(this, _valList)[index] = v;
      __privateGet(this, _keyMap).set(k, index);
      __privateGet(this, _next)[__privateGet(this, _tail)] = index;
      __privateGet(this, _prev)[index] = __privateGet(this, _tail);
      __privateSet(this, _tail, index);
      __privateWrapper(this, _size)._++;
      __privateGet(this, _addItemSize).call(this, index, size, status);
      if (status)
        status.set = "add";
      noUpdateTTL = false;
    } else {
      __privateMethod(this, _LRUCache_instances, moveToTail_fn).call(this, index);
      const oldVal = __privateGet(this, _valList)[index];
      if (v !== oldVal) {
        if (__privateGet(this, _hasFetchMethod) && __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, oldVal)) {
          oldVal.__abortController.abort(new Error("replaced"));
          const { __staleWhileFetching: s } = oldVal;
          if (s !== void 0 && !noDisposeOnSet) {
            if (__privateGet(this, _hasDispose)) {
              (_a2 = __privateGet(this, _dispose)) == null ? void 0 : _a2.call(this, s, k, "set");
            }
            if (__privateGet(this, _hasDisposeAfter)) {
              __privateGet(this, _disposed)?.push([s, k, "set"]);
            }
          }
        } else if (!noDisposeOnSet) {
          if (__privateGet(this, _hasDispose)) {
            (_b2 = __privateGet(this, _dispose)) == null ? void 0 : _b2.call(this, oldVal, k, "set");
          }
          if (__privateGet(this, _hasDisposeAfter)) {
            __privateGet(this, _disposed)?.push([oldVal, k, "set"]);
          }
        }
        __privateGet(this, _removeItemSize).call(this, index);
        __privateGet(this, _addItemSize).call(this, index, size, status);
        __privateGet(this, _valList)[index] = v;
        if (status) {
          status.set = "replace";
          const oldValue = oldVal && __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, oldVal) ? oldVal.__staleWhileFetching : oldVal;
          if (oldValue !== void 0)
            status.oldValue = oldValue;
        }
      } else if (status) {
        status.set = "update";
      }
    }
    if (ttl !== 0 && !__privateGet(this, _ttls)) {
      __privateMethod(this, _LRUCache_instances, initializeTTLTracking_fn).call(this);
    }
    if (__privateGet(this, _ttls)) {
      if (!noUpdateTTL) {
        __privateGet(this, _setItemTTL).call(this, index, ttl, start);
      }
      if (status)
        __privateGet(this, _statusTTL).call(this, status, index);
    }
    if (!noDisposeOnSet && __privateGet(this, _hasDisposeAfter) && __privateGet(this, _disposed)) {
      const dt = __privateGet(this, _disposed);
      let task;
      while (task = dt?.shift()) {
        (_c = __privateGet(this, _disposeAfter)) == null ? void 0 : _c.call(this, ...task);
      }
    }
    return this;
  }
  /**
   * Evict the least recently used item, returning its value or
   * `undefined` if cache is empty.
   */
  pop() {
    var _a2;
    try {
      while (__privateGet(this, _size)) {
        const val = __privateGet(this, _valList)[__privateGet(this, _head)];
        __privateMethod(this, _LRUCache_instances, evict_fn).call(this, true);
        if (__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, val)) {
          if (val.__staleWhileFetching) {
            return val.__staleWhileFetching;
          }
        } else if (val !== void 0) {
          return val;
        }
      }
    } finally {
      if (__privateGet(this, _hasDisposeAfter) && __privateGet(this, _disposed)) {
        const dt = __privateGet(this, _disposed);
        let task;
        while (task = dt?.shift()) {
          (_a2 = __privateGet(this, _disposeAfter)) == null ? void 0 : _a2.call(this, ...task);
        }
      }
    }
  }
  /**
   * Check if a key is in the cache, without updating the recency of use.
   * Will return false if the item is stale, even though it is technically
   * in the cache.
   *
   * Check if a key is in the cache, without updating the recency of
   * use. Age is updated if {@link LRUCache.OptionsBase.updateAgeOnHas} is set
   * to `true` in either the options or the constructor.
   *
   * Will return `false` if the item is stale, even though it is technically in
   * the cache. The difference can be determined (if it matters) by using a
   * `status` argument, and inspecting the `has` field.
   *
   * Will not update item age unless
   * {@link LRUCache.OptionsBase.updateAgeOnHas} is set.
   */
  has(k, hasOptions = {}) {
    const { updateAgeOnHas = this.updateAgeOnHas, status } = hasOptions;
    const index = __privateGet(this, _keyMap).get(k);
    if (index !== void 0) {
      const v = __privateGet(this, _valList)[index];
      if (__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v) && v.__staleWhileFetching === void 0) {
        return false;
      }
      if (!__privateGet(this, _isStale).call(this, index)) {
        if (updateAgeOnHas) {
          __privateGet(this, _updateItemAge).call(this, index);
        }
        if (status) {
          status.has = "hit";
          __privateGet(this, _statusTTL).call(this, status, index);
        }
        return true;
      } else if (status) {
        status.has = "stale";
        __privateGet(this, _statusTTL).call(this, status, index);
      }
    } else if (status) {
      status.has = "miss";
    }
    return false;
  }
  /**
   * Like {@link LRUCache#get} but doesn't update recency or delete stale
   * items.
   *
   * Returns `undefined` if the item is stale, unless
   * {@link LRUCache.OptionsBase.allowStale} is set.
   */
  peek(k, peekOptions = {}) {
    const { allowStale = this.allowStale } = peekOptions;
    const index = __privateGet(this, _keyMap).get(k);
    if (index === void 0 || !allowStale && __privateGet(this, _isStale).call(this, index)) {
      return;
    }
    const v = __privateGet(this, _valList)[index];
    return __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v) ? v.__staleWhileFetching : v;
  }
  async fetch(k, fetchOptions = {}) {
    const {
      // get options
      allowStale = this.allowStale,
      updateAgeOnGet = this.updateAgeOnGet,
      noDeleteOnStaleGet = this.noDeleteOnStaleGet,
      // set options
      ttl = this.ttl,
      noDisposeOnSet = this.noDisposeOnSet,
      size = 0,
      sizeCalculation = this.sizeCalculation,
      noUpdateTTL = this.noUpdateTTL,
      // fetch exclusive options
      noDeleteOnFetchRejection = this.noDeleteOnFetchRejection,
      allowStaleOnFetchRejection = this.allowStaleOnFetchRejection,
      ignoreFetchAbort = this.ignoreFetchAbort,
      allowStaleOnFetchAbort = this.allowStaleOnFetchAbort,
      context,
      forceRefresh = false,
      status,
      signal
    } = fetchOptions;
    if (!__privateGet(this, _hasFetchMethod)) {
      if (status)
        status.fetch = "get";
      return this.get(k, {
        allowStale,
        updateAgeOnGet,
        noDeleteOnStaleGet,
        status
      });
    }
    const options = {
      allowStale,
      updateAgeOnGet,
      noDeleteOnStaleGet,
      ttl,
      noDisposeOnSet,
      size,
      sizeCalculation,
      noUpdateTTL,
      noDeleteOnFetchRejection,
      allowStaleOnFetchRejection,
      allowStaleOnFetchAbort,
      ignoreFetchAbort,
      status,
      signal
    };
    let index = __privateGet(this, _keyMap).get(k);
    if (index === void 0) {
      if (status)
        status.fetch = "miss";
      const p = __privateMethod(this, _LRUCache_instances, backgroundFetch_fn).call(this, k, index, options, context);
      return p.__returned = p;
    } else {
      const v = __privateGet(this, _valList)[index];
      if (__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v)) {
        const stale = allowStale && v.__staleWhileFetching !== void 0;
        if (status) {
          status.fetch = "inflight";
          if (stale)
            status.returnedStale = true;
        }
        return stale ? v.__staleWhileFetching : v.__returned = v;
      }
      const isStale = __privateGet(this, _isStale).call(this, index);
      if (!forceRefresh && !isStale) {
        if (status)
          status.fetch = "hit";
        __privateMethod(this, _LRUCache_instances, moveToTail_fn).call(this, index);
        if (updateAgeOnGet) {
          __privateGet(this, _updateItemAge).call(this, index);
        }
        if (status)
          __privateGet(this, _statusTTL).call(this, status, index);
        return v;
      }
      const p = __privateMethod(this, _LRUCache_instances, backgroundFetch_fn).call(this, k, index, options, context);
      const hasStale = p.__staleWhileFetching !== void 0;
      const staleVal = hasStale && allowStale;
      if (status) {
        status.fetch = isStale ? "stale" : "refresh";
        if (staleVal && isStale)
          status.returnedStale = true;
      }
      return staleVal ? p.__staleWhileFetching : p.__returned = p;
    }
  }
  async forceFetch(k, fetchOptions = {}) {
    const v = await this.fetch(k, fetchOptions);
    if (v === void 0)
      throw new Error("fetch() returned undefined");
    return v;
  }
  memo(k, memoOptions = {}) {
    const memoMethod = __privateGet(this, _memoMethod);
    if (!memoMethod) {
      throw new Error("no memoMethod provided to constructor");
    }
    const { context, forceRefresh, ...options } = memoOptions;
    const v = this.get(k, options);
    if (!forceRefresh && v !== void 0)
      return v;
    const vv = memoMethod(k, v, {
      options,
      context
    });
    this.set(k, vv, options);
    return vv;
  }
  /**
   * Return a value from the cache. Will update the recency of the cache
   * entry found.
   *
   * If the key is not found, get() will return `undefined`.
   */
  get(k, getOptions = {}) {
    const { allowStale = this.allowStale, updateAgeOnGet = this.updateAgeOnGet, noDeleteOnStaleGet = this.noDeleteOnStaleGet, status } = getOptions;
    const index = __privateGet(this, _keyMap).get(k);
    if (index !== void 0) {
      const value = __privateGet(this, _valList)[index];
      const fetching = __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, value);
      if (status)
        __privateGet(this, _statusTTL).call(this, status, index);
      if (__privateGet(this, _isStale).call(this, index)) {
        if (status)
          status.get = "stale";
        if (!fetching) {
          if (!noDeleteOnStaleGet) {
            __privateMethod(this, _LRUCache_instances, delete_fn).call(this, k, "expire");
          }
          if (status && allowStale)
            status.returnedStale = true;
          return allowStale ? value : void 0;
        } else {
          if (status && allowStale && value.__staleWhileFetching !== void 0) {
            status.returnedStale = true;
          }
          return allowStale ? value.__staleWhileFetching : void 0;
        }
      } else {
        if (status)
          status.get = "hit";
        if (fetching) {
          return value.__staleWhileFetching;
        }
        __privateMethod(this, _LRUCache_instances, moveToTail_fn).call(this, index);
        if (updateAgeOnGet) {
          __privateGet(this, _updateItemAge).call(this, index);
        }
        return value;
      }
    } else if (status) {
      status.get = "miss";
    }
  }
  /**
   * Deletes a key out of the cache.
   *
   * Returns true if the key was deleted, false otherwise.
   */
  delete(k) {
    return __privateMethod(this, _LRUCache_instances, delete_fn).call(this, k, "delete");
  }
  /**
   * Clear the cache entirely, throwing away all values.
   */
  clear() {
    return __privateMethod(this, _LRUCache_instances, clear_fn).call(this, "delete");
  }
};
_max = /* @__PURE__ */ new WeakMap();
_maxSize = /* @__PURE__ */ new WeakMap();
_dispose = /* @__PURE__ */ new WeakMap();
_disposeAfter = /* @__PURE__ */ new WeakMap();
_fetchMethod = /* @__PURE__ */ new WeakMap();
_memoMethod = /* @__PURE__ */ new WeakMap();
_size = /* @__PURE__ */ new WeakMap();
_calculatedSize = /* @__PURE__ */ new WeakMap();
_keyMap = /* @__PURE__ */ new WeakMap();
_keyList = /* @__PURE__ */ new WeakMap();
_valList = /* @__PURE__ */ new WeakMap();
_next = /* @__PURE__ */ new WeakMap();
_prev = /* @__PURE__ */ new WeakMap();
_head = /* @__PURE__ */ new WeakMap();
_tail = /* @__PURE__ */ new WeakMap();
_free = /* @__PURE__ */ new WeakMap();
_disposed = /* @__PURE__ */ new WeakMap();
_sizes = /* @__PURE__ */ new WeakMap();
_starts = /* @__PURE__ */ new WeakMap();
_ttls = /* @__PURE__ */ new WeakMap();
_hasDispose = /* @__PURE__ */ new WeakMap();
_hasFetchMethod = /* @__PURE__ */ new WeakMap();
_hasDisposeAfter = /* @__PURE__ */ new WeakMap();
_LRUCache_instances = /* @__PURE__ */ new WeakSet();
initializeTTLTracking_fn = function() {
  const ttls = new ZeroArray2(__privateGet(this, _max));
  const starts = new ZeroArray2(__privateGet(this, _max));
  __privateSet(this, _ttls, ttls);
  __privateSet(this, _starts, starts);
  __privateSet(this, _setItemTTL, (index, ttl, start = perf.now()) => {
    starts[index] = ttl !== 0 ? start : 0;
    ttls[index] = ttl;
    if (ttl !== 0 && this.ttlAutopurge) {
      const t = setTimeout(() => {
        if (__privateGet(this, _isStale).call(this, index)) {
          __privateMethod(this, _LRUCache_instances, delete_fn).call(this, __privateGet(this, _keyList)[index], "expire");
        }
      }, ttl + 1);
      if (t.unref) {
        t.unref();
      }
    }
  });
  __privateSet(this, _updateItemAge, (index) => {
    starts[index] = ttls[index] !== 0 ? perf.now() : 0;
  });
  __privateSet(this, _statusTTL, (status, index) => {
    if (ttls[index]) {
      const ttl = ttls[index];
      const start = starts[index];
      if (!ttl || !start)
        return;
      status.ttl = ttl;
      status.start = start;
      status.now = cachedNow || getNow();
      const age = status.now - start;
      status.remainingTTL = ttl - age;
    }
  });
  let cachedNow = 0;
  const getNow = () => {
    const n = perf.now();
    if (this.ttlResolution > 0) {
      cachedNow = n;
      const t = setTimeout(() => cachedNow = 0, this.ttlResolution);
      if (t.unref) {
        t.unref();
      }
    }
    return n;
  };
  this.getRemainingTTL = (key) => {
    const index = __privateGet(this, _keyMap).get(key);
    if (index === void 0) {
      return 0;
    }
    const ttl = ttls[index];
    const start = starts[index];
    if (!ttl || !start) {
      return Infinity;
    }
    const age = (cachedNow || getNow()) - start;
    return ttl - age;
  };
  __privateSet(this, _isStale, (index) => {
    const s = starts[index];
    const t = ttls[index];
    return !!t && !!s && (cachedNow || getNow()) - s > t;
  });
};
_updateItemAge = /* @__PURE__ */ new WeakMap();
_statusTTL = /* @__PURE__ */ new WeakMap();
_setItemTTL = /* @__PURE__ */ new WeakMap();
_isStale = /* @__PURE__ */ new WeakMap();
initializeSizeTracking_fn = function() {
  const sizes = new ZeroArray2(__privateGet(this, _max));
  __privateSet(this, _calculatedSize, 0);
  __privateSet(this, _sizes, sizes);
  __privateSet(this, _removeItemSize, (index) => {
    __privateSet(this, _calculatedSize, __privateGet(this, _calculatedSize) - sizes[index]);
    sizes[index] = 0;
  });
  __privateSet(this, _requireSize, (k, v, size, sizeCalculation) => {
    if (__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v)) {
      return 0;
    }
    if (!isPosInt(size)) {
      if (sizeCalculation) {
        if (typeof sizeCalculation !== "function") {
          throw new TypeError("sizeCalculation must be a function");
        }
        size = sizeCalculation(v, k);
        if (!isPosInt(size)) {
          throw new TypeError("sizeCalculation return invalid (expect positive integer)");
        }
      } else {
        throw new TypeError("invalid size value (must be positive integer). When maxSize or maxEntrySize is used, sizeCalculation or size must be set.");
      }
    }
    return size;
  });
  __privateSet(this, _addItemSize, (index, size, status) => {
    sizes[index] = size;
    if (__privateGet(this, _maxSize)) {
      const maxSize = __privateGet(this, _maxSize) - sizes[index];
      while (__privateGet(this, _calculatedSize) > maxSize) {
        __privateMethod(this, _LRUCache_instances, evict_fn).call(this, true);
      }
    }
    __privateSet(this, _calculatedSize, __privateGet(this, _calculatedSize) + sizes[index]);
    if (status) {
      status.entrySize = size;
      status.totalCalculatedSize = __privateGet(this, _calculatedSize);
    }
  });
};
_removeItemSize = /* @__PURE__ */ new WeakMap();
_addItemSize = /* @__PURE__ */ new WeakMap();
_requireSize = /* @__PURE__ */ new WeakMap();
indexes_fn = function* ({ allowStale = this.allowStale } = {}) {
  if (__privateGet(this, _size)) {
    for (let i = __privateGet(this, _tail); true; ) {
      if (!__privateMethod(this, _LRUCache_instances, isValidIndex_fn).call(this, i)) {
        break;
      }
      if (allowStale || !__privateGet(this, _isStale).call(this, i)) {
        yield i;
      }
      if (i === __privateGet(this, _head)) {
        break;
      } else {
        i = __privateGet(this, _prev)[i];
      }
    }
  }
};
rindexes_fn = function* ({ allowStale = this.allowStale } = {}) {
  if (__privateGet(this, _size)) {
    for (let i = __privateGet(this, _head); true; ) {
      if (!__privateMethod(this, _LRUCache_instances, isValidIndex_fn).call(this, i)) {
        break;
      }
      if (allowStale || !__privateGet(this, _isStale).call(this, i)) {
        yield i;
      }
      if (i === __privateGet(this, _tail)) {
        break;
      } else {
        i = __privateGet(this, _next)[i];
      }
    }
  }
};
isValidIndex_fn = function(index) {
  return index !== void 0 && __privateGet(this, _keyMap).get(__privateGet(this, _keyList)[index]) === index;
};
evict_fn = function(free) {
  var _a2;
  const head = __privateGet(this, _head);
  const k = __privateGet(this, _keyList)[head];
  const v = __privateGet(this, _valList)[head];
  if (__privateGet(this, _hasFetchMethod) && __privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v)) {
    v.__abortController.abort(new Error("evicted"));
  } else if (__privateGet(this, _hasDispose) || __privateGet(this, _hasDisposeAfter)) {
    if (__privateGet(this, _hasDispose)) {
      (_a2 = __privateGet(this, _dispose)) == null ? void 0 : _a2.call(this, v, k, "evict");
    }
    if (__privateGet(this, _hasDisposeAfter)) {
      __privateGet(this, _disposed)?.push([v, k, "evict"]);
    }
  }
  __privateGet(this, _removeItemSize).call(this, head);
  if (free) {
    __privateGet(this, _keyList)[head] = void 0;
    __privateGet(this, _valList)[head] = void 0;
    __privateGet(this, _free).push(head);
  }
  if (__privateGet(this, _size) === 1) {
    __privateSet(this, _head, __privateSet(this, _tail, 0));
    __privateGet(this, _free).length = 0;
  } else {
    __privateSet(this, _head, __privateGet(this, _next)[head]);
  }
  __privateGet(this, _keyMap).delete(k);
  __privateWrapper(this, _size)._--;
  return head;
};
backgroundFetch_fn = function(k, index, options, context) {
  const v = index === void 0 ? void 0 : __privateGet(this, _valList)[index];
  if (__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v)) {
    return v;
  }
  const ac = new AC();
  const { signal } = options;
  signal?.addEventListener("abort", () => ac.abort(signal.reason), {
    signal: ac.signal
  });
  const fetchOpts = {
    signal: ac.signal,
    options,
    context
  };
  const cb = (v2, updateCache = false) => {
    const { aborted } = ac.signal;
    const ignoreAbort = options.ignoreFetchAbort && v2 !== void 0;
    if (options.status) {
      if (aborted && !updateCache) {
        options.status.fetchAborted = true;
        options.status.fetchError = ac.signal.reason;
        if (ignoreAbort)
          options.status.fetchAbortIgnored = true;
      } else {
        options.status.fetchResolved = true;
      }
    }
    if (aborted && !ignoreAbort && !updateCache) {
      return fetchFail(ac.signal.reason);
    }
    const bf2 = p;
    if (__privateGet(this, _valList)[index] === p) {
      if (v2 === void 0) {
        if (bf2.__staleWhileFetching) {
          __privateGet(this, _valList)[index] = bf2.__staleWhileFetching;
        } else {
          __privateMethod(this, _LRUCache_instances, delete_fn).call(this, k, "fetch");
        }
      } else {
        if (options.status)
          options.status.fetchUpdated = true;
        this.set(k, v2, fetchOpts.options);
      }
    }
    return v2;
  };
  const eb = (er) => {
    if (options.status) {
      options.status.fetchRejected = true;
      options.status.fetchError = er;
    }
    return fetchFail(er);
  };
  const fetchFail = (er) => {
    const { aborted } = ac.signal;
    const allowStaleAborted = aborted && options.allowStaleOnFetchAbort;
    const allowStale = allowStaleAborted || options.allowStaleOnFetchRejection;
    const noDelete = allowStale || options.noDeleteOnFetchRejection;
    const bf2 = p;
    if (__privateGet(this, _valList)[index] === p) {
      const del = !noDelete || bf2.__staleWhileFetching === void 0;
      if (del) {
        __privateMethod(this, _LRUCache_instances, delete_fn).call(this, k, "fetch");
      } else if (!allowStaleAborted) {
        __privateGet(this, _valList)[index] = bf2.__staleWhileFetching;
      }
    }
    if (allowStale) {
      if (options.status && bf2.__staleWhileFetching !== void 0) {
        options.status.returnedStale = true;
      }
      return bf2.__staleWhileFetching;
    } else if (bf2.__returned === bf2) {
      throw er;
    }
  };
  const pcall = (res, rej) => {
    var _a2;
    const fmp = (_a2 = __privateGet(this, _fetchMethod)) == null ? void 0 : _a2.call(this, k, v, fetchOpts);
    if (fmp && fmp instanceof Promise) {
      fmp.then((v2) => res(v2 === void 0 ? void 0 : v2), rej);
    }
    ac.signal.addEventListener("abort", () => {
      if (!options.ignoreFetchAbort || options.allowStaleOnFetchAbort) {
        res(void 0);
        if (options.allowStaleOnFetchAbort) {
          res = (v2) => cb(v2, true);
        }
      }
    });
  };
  if (options.status)
    options.status.fetchDispatched = true;
  const p = new Promise(pcall).then(cb, eb);
  const bf = Object.assign(p, {
    __abortController: ac,
    __staleWhileFetching: v,
    __returned: void 0
  });
  if (index === void 0) {
    this.set(k, bf, { ...fetchOpts.options, status: void 0 });
    index = __privateGet(this, _keyMap).get(k);
  } else {
    __privateGet(this, _valList)[index] = bf;
  }
  return bf;
};
isBackgroundFetch_fn = function(p) {
  if (!__privateGet(this, _hasFetchMethod))
    return false;
  const b = p;
  return !!b && b instanceof Promise && b.hasOwnProperty("__staleWhileFetching") && b.__abortController instanceof AC;
};
connect_fn = function(p, n) {
  __privateGet(this, _prev)[n] = p;
  __privateGet(this, _next)[p] = n;
};
moveToTail_fn = function(index) {
  if (index !== __privateGet(this, _tail)) {
    if (index === __privateGet(this, _head)) {
      __privateSet(this, _head, __privateGet(this, _next)[index]);
    } else {
      __privateMethod(this, _LRUCache_instances, connect_fn).call(this, __privateGet(this, _prev)[index], __privateGet(this, _next)[index]);
    }
    __privateMethod(this, _LRUCache_instances, connect_fn).call(this, __privateGet(this, _tail), index);
    __privateSet(this, _tail, index);
  }
};
delete_fn = function(k, reason) {
  var _a2, _b2;
  let deleted = false;
  if (__privateGet(this, _size) !== 0) {
    const index = __privateGet(this, _keyMap).get(k);
    if (index !== void 0) {
      deleted = true;
      if (__privateGet(this, _size) === 1) {
        __privateMethod(this, _LRUCache_instances, clear_fn).call(this, reason);
      } else {
        __privateGet(this, _removeItemSize).call(this, index);
        const v = __privateGet(this, _valList)[index];
        if (__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v)) {
          v.__abortController.abort(new Error("deleted"));
        } else if (__privateGet(this, _hasDispose) || __privateGet(this, _hasDisposeAfter)) {
          if (__privateGet(this, _hasDispose)) {
            (_a2 = __privateGet(this, _dispose)) == null ? void 0 : _a2.call(this, v, k, reason);
          }
          if (__privateGet(this, _hasDisposeAfter)) {
            __privateGet(this, _disposed)?.push([v, k, reason]);
          }
        }
        __privateGet(this, _keyMap).delete(k);
        __privateGet(this, _keyList)[index] = void 0;
        __privateGet(this, _valList)[index] = void 0;
        if (index === __privateGet(this, _tail)) {
          __privateSet(this, _tail, __privateGet(this, _prev)[index]);
        } else if (index === __privateGet(this, _head)) {
          __privateSet(this, _head, __privateGet(this, _next)[index]);
        } else {
          const pi = __privateGet(this, _prev)[index];
          __privateGet(this, _next)[pi] = __privateGet(this, _next)[index];
          const ni = __privateGet(this, _next)[index];
          __privateGet(this, _prev)[ni] = __privateGet(this, _prev)[index];
        }
        __privateWrapper(this, _size)._--;
        __privateGet(this, _free).push(index);
      }
    }
  }
  if (__privateGet(this, _hasDisposeAfter) && __privateGet(this, _disposed)?.length) {
    const dt = __privateGet(this, _disposed);
    let task;
    while (task = dt?.shift()) {
      (_b2 = __privateGet(this, _disposeAfter)) == null ? void 0 : _b2.call(this, ...task);
    }
  }
  return deleted;
};
clear_fn = function(reason) {
  var _a2, _b2;
  for (const index of __privateMethod(this, _LRUCache_instances, rindexes_fn).call(this, { allowStale: true })) {
    const v = __privateGet(this, _valList)[index];
    if (__privateMethod(this, _LRUCache_instances, isBackgroundFetch_fn).call(this, v)) {
      v.__abortController.abort(new Error("deleted"));
    } else {
      const k = __privateGet(this, _keyList)[index];
      if (__privateGet(this, _hasDispose)) {
        (_a2 = __privateGet(this, _dispose)) == null ? void 0 : _a2.call(this, v, k, reason);
      }
      if (__privateGet(this, _hasDisposeAfter)) {
        __privateGet(this, _disposed)?.push([v, k, reason]);
      }
    }
  }
  __privateGet(this, _keyMap).clear();
  __privateGet(this, _valList).fill(void 0);
  __privateGet(this, _keyList).fill(void 0);
  if (__privateGet(this, _ttls) && __privateGet(this, _starts)) {
    __privateGet(this, _ttls).fill(0);
    __privateGet(this, _starts).fill(0);
  }
  if (__privateGet(this, _sizes)) {
    __privateGet(this, _sizes).fill(0);
  }
  __privateSet(this, _head, 0);
  __privateSet(this, _tail, 0);
  __privateGet(this, _free).length = 0;
  __privateSet(this, _calculatedSize, 0);
  __privateSet(this, _size, 0);
  if (__privateGet(this, _hasDisposeAfter) && __privateGet(this, _disposed)) {
    const dt = __privateGet(this, _disposed);
    let task;
    while (task = dt?.shift()) {
      (_b2 = __privateGet(this, _disposeAfter)) == null ? void 0 : _b2.call(this, ...task);
    }
  }
};
let LRUCache2 = _LRUCache;
var cjs;
var hasRequiredCjs;
function requireCjs() {
  if (hasRequiredCjs) return cjs;
  hasRequiredCjs = 1;
  var isMergeableObject = function isMergeableObject2(value) {
    return isNonNullObject(value) && !isSpecial(value);
  };
  function isNonNullObject(value) {
    return !!value && typeof value === "object";
  }
  function isSpecial(value) {
    var stringValue = Object.prototype.toString.call(value);
    return stringValue === "[object RegExp]" || stringValue === "[object Date]" || isReactElement(value);
  }
  var canUseSymbol = typeof Symbol === "function" && Symbol.for;
  var REACT_ELEMENT_TYPE = canUseSymbol ? /* @__PURE__ */ Symbol.for("react.element") : 60103;
  function isReactElement(value) {
    return value.$$typeof === REACT_ELEMENT_TYPE;
  }
  function emptyTarget(val) {
    return Array.isArray(val) ? [] : {};
  }
  function cloneUnlessOtherwiseSpecified(value, options) {
    return options.clone !== false && options.isMergeableObject(value) ? deepmerge2(emptyTarget(value), value, options) : value;
  }
  function defaultArrayMerge(target, source, options) {
    return target.concat(source).map(function(element) {
      return cloneUnlessOtherwiseSpecified(element, options);
    });
  }
  function getMergeFunction(key, options) {
    if (!options.customMerge) {
      return deepmerge2;
    }
    var customMerge = options.customMerge(key);
    return typeof customMerge === "function" ? customMerge : deepmerge2;
  }
  function getEnumerableOwnPropertySymbols(target) {
    return Object.getOwnPropertySymbols ? Object.getOwnPropertySymbols(target).filter(function(symbol) {
      return Object.propertyIsEnumerable.call(target, symbol);
    }) : [];
  }
  function getKeys(target) {
    return Object.keys(target).concat(getEnumerableOwnPropertySymbols(target));
  }
  function propertyIsOnObject(object, property) {
    try {
      return property in object;
    } catch (_) {
      return false;
    }
  }
  function propertyIsUnsafe(target, key) {
    return propertyIsOnObject(target, key) && !(Object.hasOwnProperty.call(target, key) && Object.propertyIsEnumerable.call(target, key));
  }
  function mergeObject2(target, source, options) {
    var destination = {};
    if (options.isMergeableObject(target)) {
      getKeys(target).forEach(function(key) {
        destination[key] = cloneUnlessOtherwiseSpecified(target[key], options);
      });
    }
    getKeys(source).forEach(function(key) {
      if (propertyIsUnsafe(target, key)) {
        return;
      }
      if (propertyIsOnObject(target, key) && options.isMergeableObject(source[key])) {
        destination[key] = getMergeFunction(key, options)(target[key], source[key], options);
      } else {
        destination[key] = cloneUnlessOtherwiseSpecified(source[key], options);
      }
    });
    return destination;
  }
  function deepmerge2(target, source, options) {
    options = options || {};
    options.arrayMerge = options.arrayMerge || defaultArrayMerge;
    options.isMergeableObject = options.isMergeableObject || isMergeableObject;
    options.cloneUnlessOtherwiseSpecified = cloneUnlessOtherwiseSpecified;
    var sourceIsArray = Array.isArray(source);
    var targetIsArray = Array.isArray(target);
    var sourceAndTargetTypesMatch = sourceIsArray === targetIsArray;
    if (!sourceAndTargetTypesMatch) {
      return cloneUnlessOtherwiseSpecified(source, options);
    } else if (sourceIsArray) {
      return options.arrayMerge(target, source, options);
    } else {
      return mergeObject2(target, source, options);
    }
  }
  deepmerge2.all = function deepmergeAll(array, options) {
    if (!Array.isArray(array)) {
      throw new Error("first argument should be an array");
    }
    return array.reduce(function(prev, next) {
      return deepmerge2(prev, next, options);
    }, {});
  };
  var deepmerge_1 = deepmerge2;
  cjs = deepmerge_1;
  return cjs;
}
requireCjs();
var localClassNames = /* @__PURE__ */ new Set();
var composedClassLists = [];
var bufferedCSSObjs = [];
var browserRuntimeAdapter = {
  appendCss: (cssObj) => {
    bufferedCSSObjs.push(cssObj);
  },
  registerClassName: (className) => {
    localClassNames.add(className);
  },
  registerComposition: (composition) => {
    composedClassLists.push(composition);
  },
  markCompositionUsed: () => {
  },
  onEndFileScope: (fileScope) => {
    var css2 = transformCss({
      localClassNames: Array.from(localClassNames),
      composedClassLists,
      cssObjs: bufferedCSSObjs
    }).join("\n");
    injectStyles({
      fileScope,
      css: css2
    });
    bufferedCSSObjs = [];
  },
  getIdentOption: () => process.env.NODE_ENV === "production" ? "short" : "debug"
};
{
  setAdapterIfNotSet(browserRuntimeAdapter);
}
var getLastSlashBeforeIndex = (path, index) => {
  var pathIndex = index - 1;
  while (pathIndex >= 0) {
    if (path[pathIndex] === "/") {
      return pathIndex;
    }
    pathIndex--;
  }
  return -1;
};
var _getDebugFileName = (path) => {
  var file;
  var lastIndexOfDotCss = path.lastIndexOf(".css");
  if (lastIndexOfDotCss === -1) {
    return "";
  }
  var lastSlashIndex = getLastSlashBeforeIndex(path, lastIndexOfDotCss);
  file = path.slice(lastSlashIndex + 1, lastIndexOfDotCss);
  if (lastSlashIndex === -1) {
    return file;
  }
  var secondLastSlashIndex = getLastSlashBeforeIndex(path, lastSlashIndex - 1);
  var dir = path.slice(secondLastSlashIndex + 1, lastSlashIndex);
  var debugFileName = file !== "index" ? file : dir;
  return debugFileName;
};
var memoizedGetDebugFileName = () => {
  var cache = new LRUCache2({
    max: 500
  });
  return (path) => {
    var cachedResult = cache.get(path);
    if (cachedResult) {
      return cachedResult;
    }
    var result = _getDebugFileName(path);
    cache.set(path, result);
    return result;
  };
};
var getDebugFileName = memoizedGetDebugFileName();
function getDevPrefix(_ref) {
  var {
    debugId,
    debugFileName
  } = _ref;
  var parts = debugId ? [debugId.replace(/\s/g, "_")] : [];
  if (debugFileName) {
    var {
      filePath
    } = getFileScope();
    var _debugFileName = getDebugFileName(filePath);
    if (_debugFileName) {
      parts.unshift(_debugFileName);
    }
  }
  return parts.join("_");
}
function normalizeIdentifier(identifier) {
  return identifier.match(/^[0-9]/) ? "_".concat(identifier) : identifier;
}
function generateIdentifier(arg) {
  var identOption = getIdentOption2();
  var {
    debugId,
    debugFileName = true
  } = _objectSpread2(_objectSpread2({}, null), null);
  var refCount = getAndIncrementRefCounter().toString(36);
  var {
    filePath,
    packageName
  } = getFileScope();
  var fileScopeHash = murmur2(packageName ? "".concat(packageName).concat(filePath) : filePath);
  var identifier = "".concat(fileScopeHash).concat(refCount);
  if (identOption === "debug") {
    var devPrefix = getDevPrefix({
      debugId,
      debugFileName
    });
    if (devPrefix) {
      identifier = "".concat(devPrefix, "__").concat(identifier);
    }
    return normalizeIdentifier(identifier);
  }
  if (typeof identOption === "function") {
    identifier = identOption({
      hash: identifier,
      debugId,
      filePath,
      packageName
    });
    if (!identifier.match(/^[A-Z_][0-9A-Z_-]+$/i)) {
      throw new Error('Identifier function returned invalid indentifier: "'.concat(identifier, '"'));
    }
    return identifier;
  }
  return normalizeIdentifier(identifier);
}
var _templateObject;
function fontFace(rule, debugId) {
  var fontFamily = '"'.concat(cssesc(generateIdentifier(), {
    quotes: "double"
  }), '"');
  var rules = Array.isArray(rule) ? rule : [rule];
  for (var singleRule of rules) {
    if ("fontFamily" in singleRule) {
      throw new Error(dedent(_templateObject || (_templateObject = _taggedTemplateLiteral([`
      This function creates and returns a hashed font-family name, so the "fontFamily" property should not be provided.
    
      If you'd like to define a globally scoped custom font, you can use the "globalFontFace" function instead.
    `]))));
    }
    appendCss2({
      type: "fontFace",
      rule: _objectSpread2(_objectSpread2({}, singleRule), {}, {
        fontFamily
      })
    }, getFileScope());
  }
  return fontFamily;
}
function keyframes(rule, debugId) {
  var name = cssesc(generateIdentifier(), {
    isIdentifier: true
  });
  appendCss2({
    type: "keyframes",
    name,
    rule
  }, getFileScope());
  return name;
}
function isRuleKey(key) {
  return key.startsWith("@");
}
function atRuleKeyInfo(key) {
  const spaceIndex = key.indexOf(" ");
  const isToplevelRules = spaceIndex !== -1;
  return {
    isToplevelRules,
    atRuleKey: isToplevelRules ? key.substring(0, spaceIndex) : key,
    atRuleNestedKey: isToplevelRules ? key.substring(spaceIndex + 1) : ""
  };
}
function anonymousKeyInfo(keyStr) {
  const isAnimationName = isAnonymousSymbol("animationName", keyStr);
  const isFontFamily = isAnonymousSymbol("fontFamily", keyStr);
  return {
    isAnimationName,
    isFontFamily,
    isAnonymousSymbol: isAnimationName || isFontFamily
  };
}
function isAnonymousSymbol(anonymousKey, keyStr) {
  return keyStr === anonymousKey || keyStr === `${anonymousKey}$` || keyStr === `${anonymousKey}_`;
}
function atRuleKeyMerge(atRule, firstKey, secondKey) {
  if (firstKey === "" || secondKey.startsWith(firstKey)) {
    return secondKey;
  }
  if (secondKey === "") {
    return firstKey;
  }
  switch (atRule) {
    case "@layer":
      return atRuleKeyMergeByDot(firstKey, secondKey);
    default:
      return atRuleKeyMergeByAnd(firstKey, secondKey);
  }
}
function atRuleKeyMergeByAnd(firstKey, secondKey) {
  if (firstKey === "not") {
    return `not(${secondKey})`;
  }
  return `${firstKey} and ${secondKey}`;
}
function atRuleKeyMergeByDot(firstKey, secondKey) {
  return `${firstKey}.${secondKey}`;
}
const mergeObject$1 = deepmerge();
function isEmptyObject(obj) {
  return Object.keys(obj).length === 0;
}
const AT_RULE_ORDER = [
  "@layer",
  "@supports",
  "@media",
  "@container"
];
function createNestedObject(context, target) {
  const result = {};
  const pathSetter = createPathSetter(result, context);
  for (const [key, value] of Object.entries(target)) {
    if (isRuleKey(key)) {
      processRules(key, value, context, result);
    } else if (key === "selectors") {
      processSelectors(value, context, result);
    } else {
      pathSetter(key, value);
    }
  }
  return result;
}
function createPathSetter(result, context) {
  const nestedPath = AT_RULE_ORDER.filter(
    (rule) => context.parentAtRules[rule]
  ).flatMap((rule) => [rule, context.parentAtRules[rule]]);
  const isVariantReference = context.parentSelector.includes("%");
  if (context.parentSelector && !isVariantReference) {
    nestedPath.push("selectors", context.parentSelector);
  }
  const variantResult = {};
  return (key, value) => {
    let current = isVariantReference ? variantResult : result;
    for (const path of nestedPath) {
      if (path !== "__proto__" && path !== "constructor" && path !== "prototype" && current[path] === void 0) {
        current[path] = {};
      }
      current = current[path] || {};
    }
    if (key !== "__proto__" && key !== "constructor" && key !== "prototype") {
      current[key] = value;
    }
    if (isVariantReference) {
      context.variantReference = mergeObject$1(context.variantReference, {
        [context.parentSelector]: variantResult
      });
    }
  };
}
function processRules(key, value, context, result) {
  for (const [atRule, atRuleValue] of Object.entries(value)) {
    const tempContext = {
      ...context,
      parentAtRules: {
        ...context.parentAtRules,
        [key]: atRuleKeyMerge(key, context.parentAtRules[key], atRule)
      }
    };
    const nestedResult = createNestedObject(tempContext, atRuleValue);
    context.variantReference = mergeObject$1(
      context.variantReference,
      tempContext.variantReference
    );
    processNestedResult(result, nestedResult);
  }
}
function processSelectors(value, context, result) {
  for (const [selector, selectorValue] of Object.entries(value)) {
    const tempContext = {
      ...context,
      parentSelector: selector
    };
    const nestedResult = createNestedObject(tempContext, selectorValue);
    context.variantReference = mergeObject$1(
      context.variantReference,
      tempContext.variantReference
    );
    processNestedResult(result, nestedResult);
  }
}
function processNestedResult(result, nestedResult) {
  for (const [atRule, atRuleValue] of Object.entries(nestedResult)) {
    result[atRule] = mergeObject$1(
      result[atRule] ?? {},
      atRuleValue ?? {}
    );
  }
}
const upperCaseRegex = /[A-Z]/g;
function camelToKebab(camelCase) {
  return camelCase.replace(upperCaseRegex, "-$&").toLowerCase();
}
function convertToCSSVar(cssVar) {
  const without$ = cssVar.substring(1);
  const kebabCase = camelToKebab(without$);
  return `--${kebabCase}`;
}
function isUppercase(str) {
  const firstLetter = str.charCodeAt(0);
  return firstLetter >= 65 && firstLetter <= 90;
}
function replacePseudoSelectors(keyStr) {
  const kebabKeyStr = keyStr.startsWith("_") ? camelToKebab(keyStr) : keyStr;
  return hasSinglePseudoSelector(kebabKeyStr) ? `:${kebabKeyStr.substring(1, kebabKeyStr.length)}` : hasDoublePseudoSelector(kebabKeyStr) ? `::${kebabKeyStr.substring(2, kebabKeyStr.length)}` : kebabKeyStr;
}
function isSimplePseudoSelectorKey(value) {
  return value.startsWith("_");
}
function hasSinglePseudoSelector(value) {
  return value.startsWith("_") && !value.startsWith("__");
}
function hasDoublePseudoSelector(value) {
  return value.startsWith("__");
}
function isSelectorsKey(key) {
  return key === "selectors";
}
function isComplexKey(key) {
  return key.includes("&");
}
function isSimpleSelectorKey(key) {
  return key.startsWith("[") || key.startsWith(":");
}
function nestedSelectorKey(key, context) {
  const parentSelectors = splitSelector(context.parentSelector);
  const result = [];
  const parentSelectorsLength = parentSelectors.length;
  for (let i = 0; i < parentSelectorsLength; i++) {
    const selector = parentSelectors[i].trim();
    const replacedKey = key.replaceAll("&", selector);
    result.push(replacedKey);
  }
  return result.join(", ");
}
function splitSelector(selector) {
  if (!selector.includes(",")) {
    return [selector];
  }
  const result = [];
  let currentSelector = "";
  let parenLevel = 0;
  let bracketLevel = 0;
  const selectorLength = selector.length;
  for (let i = 0; i < selectorLength; i++) {
    const char = selector[i];
    switch (char) {
      case "(":
        parenLevel++;
        currentSelector += char;
        break;
      case ")":
        parenLevel--;
        currentSelector += char;
        break;
      case "[":
        bracketLevel++;
        currentSelector += char;
        break;
      case "]":
        bracketLevel--;
        currentSelector += char;
        break;
      case ",":
        if (parenLevel === 0 && bracketLevel === 0) {
          result.push(currentSelector);
          currentSelector = "";
        } else {
          currentSelector += char;
        }
        break;
      default:
        currentSelector += char;
        break;
    }
  }
  if (currentSelector.trim() !== "") {
    result.push(currentSelector);
  }
  return result;
}
function isCSSVarKey(keyStr) {
  return keyStr.startsWith("$");
}
function isPureCSSVarKey(keyStr) {
  return keyStr.startsWith("--");
}
function isVarsKey(keyStr) {
  return keyStr === "vars";
}
function replaceCSSVarKey(keyStr) {
  return convertToCSSVar(keyStr);
}
function replaceCSSVar(input) {
  let parenLevel = 0;
  let isInVariable = false;
  const resultParts = [];
  const stack = [];
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === "$") {
      stack.push({
        varPart: "$",
        fallbackPart: "",
        parenLevel
      });
      isInVariable = true;
    } else if (stack.length === 0) {
      resultParts.push(char);
    } else if (char === "(") {
      parenLevel += 1;
      if (isInVariable) {
        isInVariable = false;
        stack[stack.length - 1].parenLevel = parenLevel;
      } else {
        stack[stack.length - 1].fallbackPart += char;
      }
    } else if (char === ")") {
      if (stack[stack.length - 1].parenLevel === parenLevel) {
        if (stack.length > 1) {
          do {
            stackResolve(stack);
          } while (stack.length > 1 && stack[stack.length - 1].parenLevel === parenLevel);
        } else {
          if (stack[stack.length - 1].varPart.length <= 1) {
            stack[stack.length - 1].fallbackPart += char;
          }
          resultParts.push(stackPop(stack));
        }
      } else {
        stack[stack.length - 1].fallbackPart += char;
      }
      parenLevel -= 1;
    } else if (isVarChar(char)) {
      if (isInVariable) {
        stack[stack.length - 1].varPart += char;
      } else {
        stack[stack.length - 1].fallbackPart += char;
      }
    } else {
      isInVariable = false;
      if (stack[stack.length - 1].fallbackPart.length > 0) {
        stack[stack.length - 1].fallbackPart += char;
      } else {
        resultParts.push(`${stackPop(stack)}${char}`);
      }
    }
  }
  if (stack.length > 0) {
    while (stack.length > 1) {
      stackResolve(stack);
    }
    resultParts.push(stackPop(stack));
  }
  return resultParts.join("");
}
function stackResolve(stack) {
  const { varPart, fallbackPart } = stack.pop() ?? {
    varPart: "",
    fallbackPart: ""
  };
  stack[stack.length - 1].fallbackPart += getVarValue(varPart, fallbackPart);
}
function stackPop(stack) {
  const { varPart, fallbackPart } = stack.pop() ?? {
    varPart: "",
    fallbackPart: ""
  };
  return getVarValue(varPart, fallbackPart);
}
function getVarValue(varPart, fallbackPart) {
  return varPart.length <= 1 ? `${varPart}${fallbackPart}` : fallbackPart === "" ? `var(${convertToCSSVar(varPart)})` : `var(${convertToCSSVar(varPart)}, ${fallbackPart})`;
}
function isVarChar(char) {
  const ascii = char.charCodeAt(0);
  return ascii === 45 || ascii >= 48 && ascii <= 57 || ascii >= 65 && ascii <= 90 || ascii >= 97 && ascii <= 122 || ascii === 95;
}
function removeMergeSymbol(keyStr) {
  return keyStr.substring(0, keyStr.length - 1);
}
function mergeKeyInfo(keyStr) {
  const isMergeToComma = keyStr.endsWith("$");
  const isMergeToSpace = keyStr.endsWith("_");
  return {
    isMergeToComma,
    isMergeToSpace,
    isMergeSymbol: isMergeToComma || isMergeToSpace
  };
}
function mergeToComma(values) {
  const separator = ", ";
  if (isSingleArray(values)) {
    return values.join(separator);
  }
  return transformArray(values, separator);
}
function mergeToSpace(values) {
  const separator = " ";
  if (isSingleArray(values)) {
    return values.join(separator);
  }
  return transformArray(values, separator);
}
function isSingleArray(values) {
  return Array.isArray(values) && !values.some(Array.isArray);
}
function transformArray(values, joinMethod = ", ") {
  const result = [];
  const stack = [{ index: 0, string: "" }];
  const valueLength = values.length;
  while (stack.length > 0) {
    const { index, string } = stack.pop();
    if (index >= valueLength) {
      result.push(string);
      continue;
    }
    const currentElement = values[index];
    const nextIndex = index + 1;
    const separatedStr = `${string}${index === 0 ? "" : joinMethod}`;
    if (Array.isArray(currentElement)) {
      for (let i = currentElement.length - 1; i >= 0; i--) {
        stack.push({
          index: nextIndex,
          string: separatedStr + currentElement[i]
        });
      }
    } else {
      stack.push({
        index: nextIndex,
        string: separatedStr + currentElement
      });
    }
  }
  return result;
}
function simplyImportant(value) {
  return value.endsWith("!") ? value.endsWith(" !") ? `${value}important` : `${value.substring(0, value.length - 1)} !important` : value;
}
const LITERAL_PROPERTY_REFERENCE_REGEX = /^@[\w\-_]+$/;
const PROPERTY_REFERENCE_REGEX = /\B@[\w\-_]+/g;
function replacePropertyReference(valueStr, context) {
  if (LITERAL_PROPERTY_REFERENCE_REGEX.test(valueStr)) {
    return getReplacement(valueStr, context);
  }
  return valueStr.replace(PROPERTY_REFERENCE_REGEX, (matched) => {
    const result = getReplacement(matched, context);
    if (typeof result === "object") return JSON.stringify(result);
    return String(result);
  });
}
function getReplacement(reference, context) {
  const withoutPrefix = reference.substring(1);
  if (isPropertyKeyExist(withoutPrefix, context)) {
    const target = context.propertyReference[withoutPrefix];
    if (Array.isArray(target)) {
      return target.map(
        (v) => typeof v === "string" ? replacePropertyReference(v, context) : v
      );
    }
    return typeof target === "string" ? replacePropertyReference(target, context) : target;
  } else {
    throw new Error(`Property reference not found: ${reference}`);
  }
}
function isPropertyKeyExist(key, context) {
  return key in context.propertyReference;
}
const initTransformContext = {
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
function transformStyle(style2, context = structuredClone(initTransformContext)) {
  const newContext = {
    ...context,
    // @ts-expect-error: error ts2322: Type '`var(--${string})`' is not assignable to type 'Appearance | undefined'
    propertyReference: {
      ...context.propertyReference,
      ...style2
    }
  };
  for (const [key, value] of Object.entries(style2)) {
    if (isSelectorsKey(key)) {
      for (const [selector, style22] of Object.entries(value)) {
        transformComplexStyle(selector, style22, newContext);
      }
    } else if (isComplexKey(key)) {
      transformComplexStyle(key, value, newContext);
    } else if (isSimplePseudoSelectorKey(key)) {
      transformComplexStyle(
        `&${replacePseudoSelectors(key)}`,
        value,
        newContext
      );
    } else if (isSimpleSelectorKey(key)) {
      transformComplexStyle(`&${key}`, value, newContext);
    } else if (isVarsKey(key)) {
      for (const [varKey, varValue] of Object.entries(value)) {
        const transformedVarKey = isCSSVarKey(varKey) ? replaceCSSVarKey(varKey) : varKey;
        transformCSSVarStyle(transformedVarKey, varValue, newContext);
      }
    } else if (isCSSVarKey(key)) {
      transformCSSVarStyle(replaceCSSVarKey(key), value, newContext);
    } else if (isPureCSSVarKey(key)) {
      transformCSSVarStyle(key, value, newContext);
    } else if (isRuleKey(key)) {
      transformRuleStyle(key, value, newContext);
    } else if (isPropertyNested(newContext)) {
      transformPropertyNested(key, value, newContext);
    } else {
      transformValueStyle(key, value, newContext);
    }
  }
  mergeVariantReference(context, newContext);
  return newContext.result;
}
function insertResultValue(accessKey, key, value, context) {
  if (typeof value === "object") {
    for (const [valueKey, valueValue] of Object.entries(value)) {
      if (isRuleKey(valueKey)) {
        context.result[valueKey] = mergeObject$1(
          context.result[valueKey] ?? {},
          valueValue
        );
      } else if (valueKey === accessKey) {
        context.result[accessKey] = mergeObject$1(
          context.result[valueKey] ?? {},
          valueValue
        );
      } else {
        if (context.result[accessKey] === void 0) {
          context.result[accessKey] = {};
        }
        context.result[accessKey][key] = mergeObject$1(
          context.result[accessKey]?.[key] ?? {},
          { [valueKey]: valueValue }
        );
      }
    }
  } else {
    if (context.result[accessKey] === void 0) {
      context.result[accessKey] = {};
    }
    context.result[accessKey][key] = value;
  }
}
function transformComplexStyle(key, value, context) {
  const selector = isNestedSelector(context) ? nestedSelectorKey(key, context) : key;
  if (isPropertyNested(context)) {
    if (typeof value === "object" && !Array.isArray(value)) {
      const nestedContext = {
        ...context,
        basedKey: ""
      };
      Object.entries(value).forEach(([key2, value2]) => {
        const nestedValue = isUppercase(key2) ? { [context.basedKey + key2]: value2 } : {
          [key2]: {
            [context.basedKey]: value2
          }
        };
        insertSelectorResult(selector, nestedValue, nestedContext);
      });
    } else {
      insertSelectorResult(
        selector,
        {
          [context.basedKey]: value
        },
        context
      );
    }
  } else {
    insertSelectorResult(selector, value, context);
  }
}
function insertSelectorResult(selector, value, context) {
  if (selector.includes("%")) {
    const tempContext = {
      ...context,
      result: {},
      parentSelector: selector
    };
    insertVariantReferenceValue(
      selector,
      transformStyle(value, tempContext),
      context
    );
    mergeVariantReference(context, tempContext);
  } else {
    insertResultValue(
      "selectors",
      selector,
      transformStyle(value, {
        ...context,
        result: {},
        parentSelector: selector
      }),
      context
    );
  }
}
function insertVariantReferenceValue(key, value, context) {
  const tempContext = {
    ...context,
    parentSelector: ""
  };
  const result = {};
  const pathSetter = createPathSetter(result, tempContext);
  for (const [eachKey, eachValue] of Object.entries(value)) {
    pathSetter(eachKey, eachValue);
  }
  context.variantReference = mergeObject$1(
    context.variantReference,
    isEmptyObject(result) ? {} : {
      [key]: result
    }
  );
}
function transformPropertyNested(key, value, context) {
  if (isUppercase(key)) {
    transformValueStyle(context.basedKey + key, value, context);
  } else if (key === "base") {
    transformValueStyle(context.basedKey, value, context);
  } else {
    transformValueStyle(key, value, context);
  }
}
function transformCSSVarStyle(key, value, context) {
  insertResultValue("vars", key, value, context);
}
function transformRuleStyle(key, value, context) {
  const { isToplevelRules, atRuleKey, atRuleNestedKey } = atRuleKeyInfo(key);
  if (isToplevelRules) {
    createRuleValue(atRuleKey, atRuleNestedKey, value, context);
  } else {
    for (const [atRuleNestedKey2, atRuleStyle] of Object.entries(value)) {
      createRuleValue(atRuleKey, atRuleNestedKey2, atRuleStyle, context);
    }
  }
}
function createRuleValue(atRuleKey, atRuleNestedKey, value, context) {
  const mergedAtRuleKey = atRuleKeyMerge(
    atRuleKey,
    context.parentAtRules[atRuleKey],
    atRuleNestedKey
  );
  const otherContext = {
    ...context,
    result: {},
    parentAtRules: {
      ...context.parentAtRules,
      [atRuleKey]: mergedAtRuleKey
    }
  };
  transformValueStyle(context.basedKey, value, otherContext);
  const atRuleResult = createNestedObject(otherContext, otherContext.result);
  mergeVariantReference(context, otherContext);
  processNestedResult(context.result, atRuleResult);
}
function transformValueStyle(key, value, context) {
  const { isMergeToComma, isMergeToSpace, isMergeSymbol } = mergeKeyInfo(key);
  const transformedKey = replacePseudoSelectors(
    isMergeSymbol ? removeMergeSymbol(key) : key
  );
  if (typeof value === "object") {
    if (Array.isArray(value)) {
      transformArrayValue(
        key,
        value,
        isMergeToComma,
        isMergeToSpace,
        transformedKey,
        context
      );
    } else {
      transformObjectValue(key, value, transformedKey, context);
    }
  } else {
    context.result[transformedKey] = transformCommonValue(value, context);
  }
}
function transformArrayValue(key, values, isMergeToComma, isMergeToSpace, transformedKey, context) {
  const resolvedAnonymous = values.map((value) => {
    if (typeof value === "object") {
      return Array.isArray(value) ? value.map(
        (fallbackValue) => transformArrayAnonymousValue(key, fallbackValue)
      ) : transformArrayAnonymousValue(key, value);
    }
    return value;
  });
  const transformed = isMergeToComma ? mergeToComma(resolvedAnonymous) : isMergeToSpace ? mergeToSpace(resolvedAnonymous) : resolvedAnonymous;
  if (Array.isArray(transformed)) {
    context.result[transformedKey] = transformed.map(
      (value) => (
        // @ts-expect-error: error ts2590: expression produces a union type that is too complex to represent
        transformCommonValue(value, context)
      )
    );
  } else {
    context.result[transformedKey] = transformCommonValue(transformed, context);
  }
}
function transformArrayAnonymousValue(key, value) {
  return typeof value === "object" ? transformAnonymous(key, value) : value;
}
function transformObjectValue(key, value, transformedKey, context) {
  const transformed = transformAnonymous(key, value);
  if (typeof transformed === "string") {
    context.result[transformedKey] = transformed;
  } else {
    const tempContext = {
      ...context,
      basedKey: transformedKey
    };
    transformStyle(value, tempContext);
    mergeVariantReference(context, tempContext);
  }
}
function transformAnonymous(key, value) {
  const { isAnimationName, isFontFamily } = anonymousKeyInfo(key);
  if (isAnimationName) {
    return keyframes(value);
  }
  if (isFontFamily) {
    return fontFace(value);
  }
  return value;
}
function transformCommonValue(value, context) {
  if (typeof value === "string") {
    const result = replacePropertyReference(value, context);
    return typeof result === "string" ? simplyImportant(replaceCSSVar(result)) : result;
  }
  return value;
}
function mergeVariantReference(context, tempContext) {
  context.variantReference = mergeObject$1(
    context.variantReference,
    tempContext.variantReference
  );
}
function isPropertyNested(context) {
  return context.basedKey !== "";
}
function isNestedSelector(context) {
  return context.parentSelector !== "";
}
function transform(style2, context = structuredClone(initTransformContext)) {
  if (Array.isArray(style2)) {
    const contexts = [];
    const results = style2.map((eachStyle) => {
      const styleValue = typeof eachStyle === "function" ? eachStyle() : eachStyle;
      if (isClassNames(styleValue)) {
        return styleValue;
      }
      const tempContext = structuredClone(context);
      const result = transformStyle(styleValue, tempContext);
      contexts.push(tempContext);
      return result;
    });
    contexts.forEach((eachContext) => {
      mergeVariantReference(context, eachContext);
    });
    return results;
  }
  return transformStyle(style2, context);
}
function isClassNames(style2) {
  return typeof style2 === "string" || Array.isArray(style2);
}
const VARIANT_REFERENCE_REGEX = /\B%[\w\-_]+/g;
function replaceVariantReference(context) {
  const replacedVariantReference = {};
  for (const [key, value] of Object.entries(context.variantReference)) {
    const replacedKey = replaceVariantReferenceKey(key, context);
    replacedVariantReference[replacedKey] = value;
  }
  context.variantReference = replacedVariantReference;
}
function replaceVariantReferenceKey(keyStr, context) {
  return keyStr.replace(VARIANT_REFERENCE_REGEX, (matched) => {
    if (matched in context.variantMap) {
      return context.variantMap[matched];
    }
    throw new Error(`Variant reference not found: ${matched}`);
  });
}
function getDebugName(debugId, name) {
  return debugId ? `${debugId}_${name}` : name;
}
const VAR_PREFIX_LENGTH = "var(".length;
function getVarName(variable) {
  if (variable.startsWith("var(") && variable.endsWith(")")) {
    const inside = variable.slice(VAR_PREFIX_LENGTH, -1);
    const commaIndex = inside.indexOf(",");
    return commaIndex === -1 ? inside : inside.slice(0, commaIndex);
  }
  return variable;
}
function globalCss(selector2, rule) {
  const transformedStyle = transform({
    selectors: {
      [selector2]: {
        ...rule
      }
    }
  });
  const { selectors, ...atRuleStyles } = transformedStyle;
  if (selectors !== void 0) {
    Object.entries(selectors).forEach(([selector3, styles]) => {
      globalStyle(selector3, styles);
    });
  }
  if (atRuleStyles !== void 0) {
    const otherStyles = hoistSelectors(atRuleStyles);
    Object.entries(otherStyles.selectors).forEach(([atRule, atRuleStyles2]) => {
      globalStyle(atRule, atRuleStyles2);
    });
  }
}
function hoistSelectors(input) {
  const result = {
    selectors: {}
  };
  function processRule(rule, path = []) {
    if (hasSelectorsProperty(rule)) {
      for (const [selector2, styles] of Object.entries(rule.selectors)) {
        if (!result.selectors[selector2]) {
          result.selectors[selector2] = {};
        }
        let current = result.selectors[selector2];
        for (const [atRule, condition] of path) {
          if (!current[atRule]) {
            current[atRule] = {};
          }
          const atRuleObj = current[atRule];
          if (!atRuleObj[condition]) {
            atRuleObj[condition] = {};
          }
          current = atRuleObj[condition];
        }
        Object.assign(current, styles);
      }
    }
    for (const [key, value] of Object.entries(rule)) {
      if (isAtRuleKey(key) && isAtRuleObject(value)) {
        for (const [condition, nestedRule] of Object.entries(value)) {
          if (typeof nestedRule === "object" && nestedRule !== null) {
            processRule(
              nestedRule,
              [...path, [key, condition]]
            );
          }
        }
      }
    }
  }
  processRule(input);
  return result;
}
function hasSelectorsProperty(obj) {
  return typeof obj === "object" && obj !== null && "selectors" in obj && typeof obj.selectors === "object" && obj.selectors !== null;
}
function isAtRuleKey(key) {
  return key.startsWith("@") && (key.startsWith("@media") || key.startsWith("@supports") || key.startsWith("@container") || key.startsWith("@layer"));
}
function isAtRuleObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const css$1 = Object.assign(cssImpl, {
  raw: cssRaw,
  multiple: cssMultiple,
  with: cssWith
});
function cssRaw(style2) {
  return style2;
}
function cssImpl(style$1, debugId) {
  return style(transform(style$1), debugId);
}
function cssWith(callback) {
  const cssFunction = callback ?? ((style2) => style2);
  function cssWithImpl(style2, debugId) {
    return cssImpl(cssFunction(style2), debugId);
  }
  function cssWithRaw(style2) {
    return cssRaw(cssFunction(style2));
  }
  function cssWithMultiple(styleMap, debugId) {
    const transformedStyleMap = {};
    for (const key in styleMap) {
      transformedStyleMap[key] = cssFunction(styleMap[key]);
    }
    return cssMultiple(transformedStyleMap, debugId);
  }
  return Object.assign(cssWithImpl, {
    raw: cssWithRaw,
    multiple: cssWithMultiple
  });
}
function cssMultiple(styleMap, debugId) {
  return processMultiple(styleMap, debugId);
}
function processMultiple(items, debugId) {
  const contexts = [];
  const variantMap = {};
  const classMap = {};
  for (const key in items) {
    const context = structuredClone(initTransformContext);
    const className = style(
      transform(items[key], context),
      getDebugName(debugId, key)
    );
    contexts.push(context);
    variantMap[`%${key}`] = className;
    classMap[key] = className;
  }
  for (const context of contexts) {
    context.variantMap = variantMap;
    replaceVariantReference(context);
    for (const [key, value] of Object.entries(context.variantReference)) {
      globalCss(key, value);
    }
  }
  return classMap;
}
function addFunctionSerializer(target, recipe) {
  Object.defineProperty(target, "__recipe__", {
    value: recipe,
    writable: false
  });
  return target;
}
function mapValues(input, fn) {
  const result = {};
  for (const key in input) {
    result[key] = fn(input[key], key);
  }
  return result;
}
function transformVariantSelection(variants) {
  if (Array.isArray(variants)) {
    return variants.reduce((acc, variant) => {
      if (typeof variant === "string") {
        acc[variant] = true;
      } else {
        Object.assign(
          acc,
          variant
        );
      }
      return acc;
    }, {});
  }
  return variants ?? {};
}
function transformToggleVariants(toggleVariants) {
  const variants = {};
  for (const variantsName in toggleVariants) {
    const variantsStyle = toggleVariants[variantsName];
    variants[variantsName] = {
      true: variantsStyle
    };
  }
  return variants;
}
const shouldApplyCompound = (compoundCheck, selections, defaultVariants) => {
  for (const key of Object.keys(compoundCheck)) {
    if (compoundCheck[key] !== (selections[key] ?? defaultVariants[key])) {
      return false;
    }
  }
  return true;
};
const createRuntimeFn = (config) => {
  const runtimeFn = (options) => {
    let className = config.defaultClassName;
    const selections = {
      ...config.defaultVariants,
      ...transformVariantSelection(
        options
      )
    };
    for (const variantName in selections) {
      const variantSelection = selections[variantName] ?? config.defaultVariants[variantName];
      if (variantSelection != null) {
        let selection = variantSelection;
        if (typeof selection === "boolean") {
          selection = selection === true ? "true" : "false";
        }
        const selectionClassName = config.variantClassNames[variantName]?.[selection];
        if (selectionClassName) {
          className += " " + selectionClassName;
        }
      }
    }
    for (const [compoundCheck, compoundClassName] of config.compoundVariants) {
      if (shouldApplyCompound(compoundCheck, selections, config.defaultVariants)) {
        className += " " + compoundClassName;
      }
    }
    return className;
  };
  runtimeFn.props = (props) => {
    const result = {};
    for (const [propName, propValue] of Object.entries(props)) {
      const varName = config.propVars[propName];
      if (varName !== void 0) {
        result[varName] = propValue;
      }
    }
    return result;
  };
  runtimeFn.variants = () => Object.keys(config.variantClassNames);
  runtimeFn.classNames = {
    get base() {
      return config.defaultClassName.split(" ")[0];
    },
    get variants() {
      return mapValues(
        config.variantClassNames,
        (classNames) => mapValues(classNames, (className) => className.split(" ")[0])
      );
    }
  };
  return runtimeFn;
};
function r(e) {
  var t, f, n = "";
  if ("string" == typeof e || "number" == typeof e) n += e;
  else if ("object" == typeof e) if (Array.isArray(e)) {
    var o = e.length;
    for (t = 0; t < o; t++) e[t] && (f = r(e[t])) && (n && (n += " "), n += f);
  } else for (f in e) e[f] && (n && (n += " "), n += f);
  return n;
}
function clsx() {
  for (var e, t, f = 0, n = "", o = arguments.length; f < o; f++) (e = arguments[f]) && (t = r(e)) && (n && (n += " "), n += t);
  return n;
}
Object.assign(rulesImpl, {
  multiple: rulesMultiple,
  raw: rulesRaw,
  with: rulesWith
});
function rulesRaw(options) {
  return options;
}
function rulesWith(callback) {
  function rulesWithImpl(style2, debugId) {
    return rulesImpl(callback(style2), debugId);
  }
  function rulesWithRaw(style2) {
    return rulesRaw(callback(style2));
  }
  function rulesWithMultiple(ruleMap, debugId) {
    return processMultipleRules(
      ruleMap,
      (style2) => callback(style2),
      debugId
    );
  }
  return Object.assign(rulesWithImpl, {
    raw: rulesWithRaw,
    multiple: rulesWithMultiple
  });
}
const mergeObject = deepmerge();
function rulesImpl(options, debugId) {
  const {
    toggles = {},
    variants = {},
    defaultVariants = {},
    compoundVariants = [],
    props = {},
    base,
    ...baseStyles
  } = options;
  const propVars = {};
  const propStyles = {};
  if (Array.isArray(props)) {
    for (const prop of props) {
      if (typeof prop === "string") {
        const debugName = getDebugName(debugId, prop);
        const propVar = createVar(debugName);
        propVars[prop] = getVarName(propVar);
        setCSSProperty(propStyles, prop, propVar);
      } else {
        processPropObject(prop, propVars, propStyles, debugId);
      }
    }
  } else {
    processPropObject(props, propVars, propStyles, debugId);
  }
  let defaultClassName;
  if (!base || typeof base === "string") {
    const baseClassName = css$1([baseStyles, propStyles], debugId);
    defaultClassName = base ? `${baseClassName} ${base}` : baseClassName;
  } else {
    defaultClassName = css$1(
      Array.isArray(base) ? [baseStyles, ...base, propStyles] : [mergeObject(baseStyles, base), propStyles],
      debugId
    );
  }
  const mergedVariants = mergeObject(
    variants,
    transformToggleVariants(toggles)
  );
  const variantClassNames = mapValues(mergedVariants, (variantGroup, variantGroupName) => {
    const transformedVariants = {};
    for (const key in variantGroup) {
      const styleRule = variantGroup[key];
      transformedVariants[key] = typeof styleRule === "string" ? [styleRule] : styleRule;
    }
    return css$1.multiple(
      transformedVariants,
      getDebugName(debugId, String(variantGroupName))
    );
  });
  const compounds = [];
  if (typeof compoundVariants === "function") {
    const variantConditions = mapValues(
      mergedVariants,
      (variantGroup, variantName) => mapValues(variantGroup, (_, optionKey) => ({
        [variantName]: optionKey === "true" ? true : optionKey === "false" ? false : optionKey
      }))
    );
    const compoundRules = compoundVariants(variantConditions);
    compoundRules.forEach((rule, index) => {
      const variants2 = rule.condition.reduce((acc, condition) => {
        return {
          ...acc,
          ...condition
        };
      }, {});
      compounds.push([
        transformVariantSelection(variants2),
        processCompoundStyle(rule.style, debugId, index)
      ]);
    });
  }
  const config = {
    defaultClassName,
    variantClassNames,
    defaultVariants: transformVariantSelection(defaultVariants),
    compoundVariants: compounds,
    propVars
  };
  return addFunctionSerializer(
    createRuntimeFn(config),
    {
      importPath: "@mincho-js/css/rules/createRuntimeFn",
      importName: "createRuntimeFn",
      args: [config]
    }
  );
}
function setCSSProperty(styles, property, value) {
  styles[property] = value;
}
function processPropObject(props, propVars, propStyles, debugId) {
  Object.entries(props).forEach(([propName, propValue]) => {
    const debugName = getDebugName(debugId, propName);
    const propVar = createVar(debugName);
    propVars[propName] = getVarName(propVar);
    const isBaseValue = propValue?.base !== void 0;
    propValue?.targets.forEach((target) => {
      setCSSProperty(
        propStyles,
        target,
        isBaseValue ? fallbackVar(propVar, `${propValue.base}`) : propVar
      );
    });
  });
}
function processCompoundStyle(style2, debugId, index) {
  return typeof style2 === "string" ? style2 : css$1(style2, getDebugName(debugId, `compound_${index}`));
}
function rulesMultiple(patternMap, debugId) {
  return processMultipleRules(
    patternMap,
    (pattern) => pattern,
    debugId
  );
}
function processMultipleRules(items, transformItem, debugId) {
  const patternsMap = {};
  for (const key in items) {
    const pattern = transformItem(items[key], key);
    patternsMap[key] = rulesImpl(pattern, getDebugName(debugId, key));
  }
  return patternsMap;
}
const cxImpl = clsx;
Object.assign(cxImpl, {
  multiple: cxMultiple,
  with: cxWith
});
function cxMultiple(map) {
  const result = {};
  for (const key in map) {
    result[key] = cxImpl(map[key]);
  }
  return result;
}
function cxWith(callback) {
  const cxFunction = callback ?? ((className) => className);
  function cxWithImpl(...className) {
    const result = className.map((cn) => cxFunction(cn));
    return cxImpl(...result);
  }
  function cxWithMultiple(classNameMap) {
    const transformedClassNameMap = {};
    for (const key in classNameMap) {
      transformedClassNameMap[key] = cxFunction(classNameMap[key]);
    }
    return cxMultiple(transformedClassNameMap);
  }
  return Object.assign(cxWithImpl, { multiple: cxWithMultiple });
}
const DEFINE_RULES_PRESET_SCHEMA = "mincho.defineRulesPreset";
const DEFINE_RULES_PRESET_VERSION = 2;
function freezePresetSnapshot(preset) {
  return Object.freeze({
    schema: preset.schema,
    version: preset.version,
    classNameByCache: Object.freeze({ ...preset.classNameByCache })
  });
}
function isPlainObject$1(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function sortByStableString(items) {
  return [...items].map((item) => ({ item, key: JSON.stringify(item) })).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0).map(({ item }) => item);
}
function canonicalize(value, stack = /* @__PURE__ */ new WeakSet()) {
  if (value === null) {
    return ["null"];
  }
  switch (typeof value) {
    case "string":
      return ["string", value];
    case "boolean":
      return ["boolean", value];
    case "number":
      if (Number.isNaN(value)) {
        return ["number", "NaN"];
      }
      if (Object.is(value, -0)) {
        return ["number", "-0"];
      }
      return ["number", String(value)];
    case "bigint":
      return ["bigint", value.toString()];
    case "undefined":
      return ["undefined"];
    case "object":
      break;
    default:
      throw new TypeError(`지원하지 않는 타입입니다: ${typeof value}`);
  }
  if (value instanceof Date) {
    return ["date", value.toISOString()];
  }
  if (stack.has(value)) {
    throw new TypeError("순환 참조는 지원하지 않습니다.");
  }
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return ["array", value.map((item) => canonicalize(item, stack))];
    }
    if (value instanceof Set) {
      const items = [...value].map((item) => canonicalize(item, stack));
      return ["set", sortByStableString(items)];
    }
    if (value instanceof Map) {
      const entries = [...value.entries()].map(
        ([k, v]) => [canonicalize(k, stack), canonicalize(v, stack)]
      );
      return ["map", sortByStableString(entries)];
    }
    if (isPlainObject$1(value)) {
      const entries = Object.keys(value).sort().map(
        (key) => [key, canonicalize(value[key], stack)]
      );
      return ["object", entries];
    }
    throw new TypeError("plain object, Array, Set, Map, Date만 지원합니다.");
  } finally {
    stack.delete(value);
  }
}
function pairCacheKey(key, value) {
  return JSON.stringify(["pair", canonicalize(key), canonicalize(value)]);
}
function fragmentCacheKey(key, value, fragment) {
  return JSON.stringify([
    "fragment",
    canonicalize(key),
    canonicalize(value),
    canonicalize(fragment)
  ]);
}
function mergePresetEntries(presets = []) {
  const cacheEntries = {};
  for (let presetIndex = 0; presetIndex < presets.length; presetIndex += 1) {
    const preset = presets[presetIndex];
    if (preset.schema !== DEFINE_RULES_PRESET_SCHEMA) {
      throw new Error(
        `[defineRules] Unsupported preset schema: "${preset.schema}". Expected "${DEFINE_RULES_PRESET_SCHEMA}".`
      );
    }
    if (preset.version !== DEFINE_RULES_PRESET_VERSION) {
      throw new Error(
        `[defineRules] Unsupported preset artifact version: ${String(
          preset.version
        )}. Expected ${DEFINE_RULES_PRESET_VERSION}.`
      );
    }
    const presetEntries = Object.entries(preset.classNameByCache);
    for (let entryIndex = 0; entryIndex < presetEntries.length; entryIndex += 1) {
      const [cacheKey, className] = presetEntries[entryIndex];
      const existingClassName = cacheEntries[cacheKey];
      if (existingClassName == null) {
        cacheEntries[cacheKey] = className;
        continue;
      }
      if (existingClassName === className) {
        continue;
      }
      throw new Error(
        `[defineRules] Conflicting preset artifact entry for cache key "${cacheKey}". First className "${existingClassName}" differs from artifact[${presetIndex}] classNameByCache[${JSON.stringify(cacheKey)}] "${className}".`
      );
    }
  }
  return cacheEntries;
}
function createCanonicalStyleCache(debugId, presets = []) {
  let classNameCache = mergePresetEntries(presets);
  function hasCacheKey(cacheKey) {
    return cacheKey in classNameCache;
  }
  function getCachedClassName(cacheKey) {
    return classNameCache[cacheKey];
  }
  function cacheClassName(cacheKey, style2) {
    const classNameOrUndefined = classNameCache[cacheKey];
    if (classNameOrUndefined != null) {
      return classNameOrUndefined;
    }
    const className = css$1(style2, debugId);
    classNameCache[cacheKey] = className;
    return className;
  }
  function has(key, value) {
    return hasCacheKey(pairCacheKey(key, value));
  }
  function get(key, value) {
    return getCachedClassName(pairCacheKey(key, value));
  }
  function add(key, value) {
    return cacheClassName(pairCacheKey(key, value), {
      [key]: value
    });
  }
  function hasFragment(key, value, fragment) {
    return hasCacheKey(fragmentCacheKey(key, value, fragment));
  }
  function getFragment(key, value, fragment) {
    return getCachedClassName(fragmentCacheKey(key, value, fragment));
  }
  function addFragment(key, value, fragment) {
    return cacheClassName(fragmentCacheKey(key, value, fragment), fragment);
  }
  function clear() {
    classNameCache = mergePresetEntries(presets);
  }
  function serializePreset() {
    return {
      schema: DEFINE_RULES_PRESET_SCHEMA,
      version: DEFINE_RULES_PRESET_VERSION,
      classNameByCache: { ...classNameCache }
    };
  }
  function getSnapshot() {
    return freezePresetSnapshot(serializePreset());
  }
  return {
    has,
    get,
    add,
    hasFragment,
    getFragment,
    addFragment,
    clear,
    serializePreset,
    getSnapshot,
    get size() {
      return Object.keys(classNameCache).length;
    }
  };
}
function defineRules(config) {
  const styleCache = createCanonicalStyleCache(config.debugId, config.presets);
  function resolveToFragments(args) {
    const fragments = [];
    applyInput(config, fragments, args, []);
    return fragments;
  }
  function cssRaw2(args) {
    return flattenResolvedFragments(resolveToFragments(args));
  }
  function cssImpl2(args) {
    const fragments = resolveToFragments(args);
    const emittedFragments = collectEmittedFragments(fragments);
    const output = [];
    for (const fragment of emittedFragments) {
      const className = styleCache.addFragment(
        fragment.inputIdentity.property,
        fragment.inputIdentity.value,
        fragment.style
      );
      output.push(className);
    }
    return output.join(" ");
  }
  function serializePreset() {
    return styleCache.serializePreset();
  }
  const css2 = Object.assign(cssImpl2, { raw: cssRaw2 });
  return { css: css2, serializePreset };
}
function collectEmittedFragments(fragments) {
  const occupiedKeys = /* @__PURE__ */ new Set();
  const emittedFragments = [];
  for (let index = fragments.length - 1; index >= 0; index -= 1) {
    const fragment = fragments[index];
    if (fragment == null) continue;
    const emittedFragment = omitOccupiedKeys(fragment, occupiedKeys);
    if (emittedFragment == null) {
      continue;
    }
    emittedFragments.push(emittedFragment);
    for (const key of emittedFragment.outputKeys) {
      occupiedKeys.add(key);
    }
  }
  return emittedFragments.reverse();
}
function omitOccupiedKeys(fragment, occupiedKeys) {
  const remainingOutputKeys = fragment.outputKeys.filter(
    (key) => !occupiedKeys.has(key)
  );
  if (remainingOutputKeys.length === 0) {
    return void 0;
  }
  if (remainingOutputKeys.length === fragment.outputKeys.length) {
    return fragment;
  }
  const nextStyle = {};
  for (const key of remainingOutputKeys) {
    nextStyle[key] = fragment.style[key];
  }
  return {
    ...fragment,
    outputKeys: remainingOutputKeys,
    style: nextStyle
  };
}
function flattenResolvedFragments(fragments) {
  const mergedStyle = {};
  for (const fragment of fragments) {
    Object.assign(mergedStyle, fragment.style);
  }
  return mergedStyle;
}
function pushResolvedFragment(fragmentsOut, inputIdentity, shortcutStack, style2) {
  const outputKeys = Object.keys(style2);
  if (outputKeys.length === 0) return;
  fragmentsOut.push({
    source: {
      key: inputIdentity.property,
      shortcutStack: [...shortcutStack]
    },
    inputIdentity,
    outputKeys,
    style: style2
  });
}
function applyInput(ctx, fragmentsOut, input, shortcutStack) {
  if (input == null || input === false) return;
  if (typeof input === "string") {
    applyInlineShortcut(ctx, fragmentsOut, input, shortcutStack);
    return;
  }
  if (Array.isArray(input)) {
    applyArray(ctx, fragmentsOut, input, shortcutStack);
    return;
  }
  if (isPlainObject(input)) {
    applyObject(ctx, fragmentsOut, input, shortcutStack);
    return;
  }
  throw new Error(`Unsupported css() argument: ${String(input)}`);
}
function applyInlineShortcut(ctx, fragmentsOut, shortcutName, shortcutStack) {
  if (hasOwn(ctx.shortcuts, shortcutName)) {
    applyShortcut(ctx, fragmentsOut, shortcutName, void 0, shortcutStack);
    return;
  }
  throw new Error(`Unknown fixed style: "${shortcutName}"`);
}
function applyArray(ctx, fragmentsOut, arr, shortcutStack) {
  for (const item of arr) {
    applyInput(ctx, fragmentsOut, item, shortcutStack);
  }
}
function applyObject(ctx, fragmentsOut, obj, shortcutStack) {
  for (const [k, v] of Object.entries(obj)) {
    applyEntry(ctx, fragmentsOut, k, v, shortcutStack);
  }
}
function applyEntry(ctx, fragmentsOut, key, value, shortcutStack) {
  if (hasOwn(ctx.shortcuts, key)) {
    applyShortcut(ctx, fragmentsOut, key, value, shortcutStack);
    return;
  }
  applyProperty(ctx, fragmentsOut, key, value, shortcutStack);
}
function applyProperty(ctx, fragmentsOut, prop, value, shortcutStack) {
  const propertyDefinition = ctx.properties?.[prop];
  if (typeof propertyDefinition === "function") {
    const result = propertyDefinition(value);
    if (isPlainObject(result)) {
      pushResolvedFragment(
        fragmentsOut,
        { property: prop, value },
        shortcutStack,
        result
      );
      return;
    } else {
      pushResolvedFragment(
        fragmentsOut,
        { property: prop, value },
        shortcutStack,
        {
          [prop]: result
        }
      );
      return;
    }
  }
  if (isPlainObject(propertyDefinition) === false) {
    pushResolvedFragment(
      fragmentsOut,
      { property: prop, value },
      shortcutStack,
      {
        [prop]: value
      }
    );
    return;
  }
  const mappedValue = propertyDefinition[value];
  if (isPlainObject(mappedValue)) {
    pushResolvedFragment(
      fragmentsOut,
      { property: prop, value },
      shortcutStack,
      mappedValue
    );
    return;
  }
  pushResolvedFragment(fragmentsOut, { property: prop, value }, shortcutStack, {
    [prop]: mappedValue ?? value
  });
}
function applyShortcutReference(ctx, fragmentsOut, targetName, value, shortcutStack) {
  if (hasOwn(ctx.shortcuts, targetName)) {
    applyShortcut(ctx, fragmentsOut, targetName, value, shortcutStack);
    return;
  }
  applyProperty(ctx, fragmentsOut, targetName, value, shortcutStack);
}
function applyShortcut(ctx, fragmentsOut, name, value, shortcutStack) {
  if (shortcutStack.includes(name)) {
    throw new Error(
      `Circular shortcut reference: ${[...shortcutStack, name].join(" -> ")}`
    );
  }
  const shortcutDefinition = ctx.shortcuts?.[name];
  if (shortcutDefinition == null) return;
  const nextShortcutStack = shortcutStack.concat(name);
  if (typeof shortcutDefinition === "string") {
    applyShortcutReference(
      ctx,
      fragmentsOut,
      shortcutDefinition,
      value,
      nextShortcutStack
    );
    return;
  }
  if (Array.isArray(shortcutDefinition)) {
    for (const alias of shortcutDefinition) {
      applyShortcutReference(
        ctx,
        fragmentsOut,
        alias,
        value,
        nextShortcutStack
      );
    }
    return;
  }
  if (typeof shortcutDefinition === "function") {
    const produced = shortcutDefinition(value);
    applyInput(ctx, fragmentsOut, produced, nextShortcutStack);
    return;
  }
  if (isPlainObject(shortcutDefinition)) {
    if (value === void 0 || value === true) {
      applyInput(ctx, fragmentsOut, shortcutDefinition, nextShortcutStack);
      return;
    }
    if (!value) return;
    applyInput(ctx, fragmentsOut, shortcutDefinition, nextShortcutStack);
    return;
  }
  throw new Error(`Unsupported shortcut definition for "${name}"`);
}
function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}
function hasOwn(obj, key) {
  return obj != null && Object.prototype.hasOwnProperty.call(obj, key);
}
const runtimePreset = defineRules({ debugId: "provider-module", properties: { color: true, display: true }, presets: [{ schema: "mincho.defineRulesPreset", version: 2, classNameByCache: {} }] });
const { css } = runtimePreset;
var shared = "qm85120 qm85121";
export {
  css,
  shared
};
