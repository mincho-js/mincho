import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@mincho-js/preset-theme-ui/styles.css";

import { App } from "./app.js";
import "./style.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
