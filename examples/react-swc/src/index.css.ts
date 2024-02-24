import { globalStyle } from "@mincho/css"

globalStyle(":root", {
  fontFamily: "Inter , system-ui , Avenir , Helvetica , Arial , sans-serif",
  lineHeight: "1.5",
  fontWeight: "400",

  colorScheme: "light dark",
  color: "rgba(255,255,255,0.87)",
  backgroundColor: "#242424",

  fontSynthesis: "none",
  textRendering: "optimizeLegibility",
  WebkitFontSmoothing: "antialiased",
  MozOsxFontSmoothing: "grayscale",

  "@media (prefers-color-scheme: light)": {
    color: "#213547",
    backgroundColor: "#ffffff",
  },
});

globalStyle("a", {
  fontWeight: "500",
  color: "#646cff",
  textDecoration: "inherit",
});
globalStyle("a:hover", {
  color: "#535bf2",
  "@media (prefers-color-scheme: light)": {
    color: "#747bff",
  },
});

globalStyle("body", {
  margin: "0",
  display: "flex",
  placeItems: "center",
  minWidth: "320px",
  minHeight: "100vh",
});

globalStyle("h1", {
  fontSize: "3.2em",
  lineHeight: "1.1",
});

globalStyle("button", {
  borderRadius: "8px",
  border: "1px solid transparent",
  padding: "0.6em 1.2em",
  fontSize: "1em",
  fontWeight: "500",
  fontFamily: "inherit",
  backgroundColor: "#1a1a1a",
  cursor: "pointer",
  transition: "border-color 0.25s",
  "@media (prefers-color-scheme: light)": {
    backgroundColor: "#f9f9f9",
  },
});

globalStyle("button:hover", {
  borderColor: "#646cff",
});

globalStyle("button:focus, button:focus-visible", {
  outline: "4px auto -webkit-focus-ring-color",
});

