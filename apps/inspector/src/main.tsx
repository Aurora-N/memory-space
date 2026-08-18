import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";
import "./styles/pages.css";
import "./styles/responsive.css";

const root = document.getElementById("root");
if (!root) throw new Error("Inspector root element was not found");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
