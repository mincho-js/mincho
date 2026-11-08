import { theme } from "@mincho-js/css";

const tokens = {
  color: {
    accent: "#e4e84e",
    ink: "#17231a",
    surface: "#d8efde"
  },
  space: { sm: "8px", md: "12px", lg: "24px" },
  radius: "8px"
};

export const [mintTheme, vars, contract] = theme(tokens);

export const [peachTheme] = theme.extends(contract, {
  ...tokens,
  color: {
    accent: "#eea080",
    ink: "#322219",
    surface: "#f9e0d2"
  }
});
