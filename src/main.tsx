import './util/handleError';
import './util/setupServiceWorker';

import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";
import './styles/index.scss';

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />
);
