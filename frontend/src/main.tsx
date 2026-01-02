import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  // NOTE: React.StrictMode intentionally double-invokes certain lifecycle
  // methods/effects in development to help surface side effects. That results
  // in duplicate API calls when components fetch data in useEffect().
  // We disable StrictMode here to keep network behavior intuitive.
  <BrowserRouter>
    <App />
  </BrowserRouter>
);
