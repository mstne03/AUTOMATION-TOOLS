import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { iniciarTema } from "./state/tema";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles.css";

iniciarTema();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
