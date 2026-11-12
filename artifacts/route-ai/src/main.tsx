import { createRoot } from "react-dom/client";
import "./lib/workspace-context";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
