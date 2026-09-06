import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Popup } from "./Popup";
import "./style.css";

const isPopup = location.pathname.endsWith("/popup.html");
createRoot(document.getElementById("root")!).render(
  isPopup ? <Popup /> : <App />,
);
