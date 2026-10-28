import { forwardConsoleToLog } from "@living-diorama/desktop-integration";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Studio } from "./Studio";
import "./studio.css";

forwardConsoleToLog();

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <Studio />
  </StrictMode>,
);
