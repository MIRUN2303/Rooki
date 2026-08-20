import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

/* Mic access requires a secure context (https or localhost). If the page is
   served over a plain-http LAN IP (vite binds all interfaces), hop to
   localhost automatically so getUserMedia + the STT proxy both work. */
if (
  !window.isSecureContext &&
  location.protocol === "http:" &&
  location.hostname !== "localhost" &&
  location.hostname !== "127.0.0.1"
) {
  location.replace(`http://localhost:${location.port || 5173}${location.pathname}${location.search}${location.hash}`);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
