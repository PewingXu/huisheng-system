import { createRoot } from "react-dom/client";
import App from "./App";

// 本地字体（避免依赖 Google Fonts CDN）
import "@fontsource/noto-sans-sc/300.css";
import "@fontsource/noto-sans-sc/400.css";
import "@fontsource/noto-sans-sc/500.css";
import "@fontsource/noto-sans-sc/600.css";
import "@fontsource/noto-sans-sc/700.css";
import "@fontsource/roboto-mono/400.css";
import "@fontsource/roboto-mono/500.css";
import "@fontsource/roboto-mono/600.css";

import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
