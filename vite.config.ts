import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";
import { vitePluginManusRuntime } from "vite-plugin-manus-runtime";

// =============================================================================
// Manus Debug Collector - Vite Plugin
// Writes browser logs directly to files, trimmed when exceeding size limit
// =============================================================================

const PROJECT_ROOT = import.meta.dirname;
const LOG_DIR = path.join(PROJECT_ROOT, ".manus-logs");
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024; // 1MB per log file
const TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6); // Trim to 60% to avoid constant re-trimming

type LogSource = "browserConsole" | "networkRequests" | "sessionReplay";

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function trimLogFile(logPath: string, maxSize: number) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }

    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines: string[] = [];
    let keptBytes = 0;

    // Keep newest lines (from end) that fit within 60% of maxSize
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}\n`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }

    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
    /* ignore trim errors */
  }
}

function writeToLogFile(source: LogSource, entries: unknown[]) {
  if (entries.length === 0) return;

  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);

  // Format entries with timestamps
  const lines = entries.map((entry) => {
    const ts = new Date().toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });

  // Append to log file
  fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf-8");

  // Trim if exceeds max size
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}

/**
 * Vite plugin to collect browser debug logs
 * - POST /__manus__/logs: Browser sends logs, written directly to files
 * - Files: browserConsole.log, networkRequests.log, sessionReplay.log
 * - Auto-trimmed when exceeding 1MB (keeps newest entries)
 */
function vitePluginManusDebugCollector(): Plugin {
  return {
    name: "manus-debug-collector",

    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__manus__/debug-collector.js",
              defer: true,
            },
            injectTo: "head",
          },
        ],
      };
    },

    configureServer(server: ViteDevServer) {
      // POST /__manus__/logs: Browser sends logs (written directly to files)
      server.middlewares.use("/__manus__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }

        const handlePayload = (payload: any) => {
          // Write logs directly to files
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };

        const reqBody = (req as { body?: unknown }).body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    },
  };
}

// =============================================================================
// Python API Server - Vite Plugin
// 在开发模式下自动启动 Python FastAPI 后端
// =============================================================================

const PYTHON_API_PORT = 8766;

function vitePluginPythonApi(): Plugin {
  let pythonProcess: ChildProcess | null = null;

  return {
    name: "python-api-server",

    configureServer() {
      // 尝试启动 Python 后端
      const projectRoot = import.meta.dirname;
      const apiScript = path.join(projectRoot, "api_server.py");

      if (!fs.existsSync(apiScript)) {
        console.log("[Python API] api_server.py not found, skipping");
        return;
      }

      // 先检查是否已有打包好的 exe
      const exePath = path.join(projectRoot, "dist", "huisheng_api", "huisheng_api.exe");
      const useExe = fs.existsSync(exePath);

      // 优先使用 anaconda Python（系统 Python 3.14 alpha 不兼容 pydantic）
      const anacondaPython = "C:\\Users\\xpr12\\anaconda3\\python.exe";
      const fallbackPython = fs.existsSync(anacondaPython) ? anacondaPython : "python";
      const cmd = useExe ? exePath : fallbackPython;
      const args = useExe ? [] : [apiScript];
      const env = { ...process.env, PYTHON_API_PORT: String(PYTHON_API_PORT) };

      console.log(`[Python API] Starting ${useExe ? "exe" : "python"} backend on port ${PYTHON_API_PORT}...`);

      pythonProcess = spawn(cmd, args, {
        cwd: projectRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });

      pythonProcess.stdout?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[Python API] ${msg}`);
      });

      pythonProcess.stderr?.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        if (msg) console.log(`[Python API] ${msg}`);
      });

      pythonProcess.on("error", (err) => {
        console.log(`[Python API] Failed to start: ${err.message}`);
        console.log("[Python API] Frontend will use JS fallback for analysis");
        pythonProcess = null;
      });

      pythonProcess.on("exit", (code) => {
        if (code !== null && code !== 0) {
          console.log(`[Python API] Process exited with code ${code}`);
        }
        pythonProcess = null;
      });

      // 在 Vite 关闭时终止 Python 进程
      process.on("exit", () => {
        if (pythonProcess) {
          pythonProcess.kill();
          pythonProcess = null;
        }
      });
    },
  };
}

const plugins = [react(), tailwindcss(), jsxLocPlugin(), vitePluginManusRuntime(), vitePluginManusDebugCollector(), vitePluginPythonApi()];

export default defineConfig({
  plugins,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "client", "src"),
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
  envDir: path.resolve(import.meta.dirname),
  root: path.resolve(import.meta.dirname, "client"),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    strictPort: false, // Will find next available port if 3000 is busy
    host: true,
    allowedHosts: [
      ".manuspre.computer",
      ".manus.computer",
      ".manus-asia.computer",
      ".manuscomputer.ai",
      ".manusvm.computer",
      "localhost",
      "127.0.0.1",
    ],
    fs: {
      strict: true,
      deny: ["**/.*"],
    },
    proxy: {
      "/pyapi": {
        target: `http://127.0.0.1:${PYTHON_API_PORT}`,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/pyapi/, ""),
      },
    },
  },
});
