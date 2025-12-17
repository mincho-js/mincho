import type {
  NonNullableString,
  CSSProperties,
  CSSPropertiesWithVars
} from "@mincho-js/transform-to-vanilla";

type DefineRulesCssProperties = {
  [Property in keyof CSSProperties]?:
    | ReadonlyArray<CSSProperties[Property]>
    | Record<string, CSSProperties[Property] | CSSPropertiesWithVars>
    | true
    | false;
};
type DefineRulesCustomProperties = Partial<
  Record<
    Exclude<NonNullableString, keyof CSSProperties>,
    Record<string, CSSPropertiesWithVars>
  >
>;
type DefineRulesProperties =
  | DefineRulesCssProperties
  | DefineRulesCustomProperties;

type DefineRulesShortcut<Properties extends DefineRulesProperties> = Record<
  string,
  keyof Properties | ReadonlyArray<keyof Properties> | Properties
>;

interface DefineRulesArgs<Properties extends DefineRulesProperties> {
  properties: Properties;
  shortcuts?: DefineRulesShortcut<Properties>;
}
export function defineRules<const Properties extends DefineRulesProperties>(
  rules: DefineRulesArgs<Properties>
) {
  return rules;
}

const alpha = "--alpha";
export const abc = defineRules({
  properties: {
    // Allow only values in arrays
    display: ["none", "inline"],
    paddingLeft: [0, 2, 4, 8, 16, 32, 64],
    paddingRight: [0, 2, 4, 8, 16, 32, 64],

    // Allow only values in objects
    color: { "indigo-800": "rgb(55, 48, 163)" },
    background: {
      red: {
        vars: { [alpha]: "1" },
        background: `rgba(255, 0, 0, ${alpha})`
      }
    },

    // Custom Properties
    backgroundOpacity: {
      1: { vars: { [alpha]: "1" } },
      0.1: { vars: { [alpha]: "0.1" } }
    },

    //Entire properties
    border: false
  },
  shortcuts: {
    pl: "paddingLeft",
    pr: "paddingRight",
    px: ["paddingLeft", "paddingRight"]
  }
});
