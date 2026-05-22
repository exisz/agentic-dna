#!/usr/bin/env node
/**
 * `dna ui` — start/stop the DNA Mesh visualization dashboard.
 *
 * Usage:
 *   dna ui                  Start (default port 4893), open in browser
 *   dna ui --port 5000      Custom port
 *   dna ui --stop           Stop the running service
 *   dna ui --status         Show status
 *   dna ui --logs           Tail logs
 *   dna ui --install-service Install oxmgr as a login service and register DNA UI
 *   dna ui --foreground     Run in foreground (no oxmgr) — useful for debugging
 *   dna ui --no-open        Don't open browser
 */
import { spawn, spawnSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
// repo root: scripts/ -> ../
const REPO_ROOT = resolve(__dirname, "..");
const GUI_DIR = join(REPO_ROOT, "gui");
const SERVICE_NAME = "dna-ui";
const OXMGR_JS = join(GUI_DIR, "node_modules", "oxmgr", "bin", "oxmgr.js");
const TSX_CLI = join(GUI_DIR, "node_modules", "tsx", "dist", "cli.mjs");
const SERVER_PATH = join(GUI_DIR, "src", "server.ts");

function parseArgs(argv: string[]) {
  const args = {
    port: 4893,
    stop: false,
    status: false,
    logs: false,
    installService: false,
    foreground: false,
    open: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--stop") args.stop = true;
    else if (a === "--status") args.status = true;
    else if (a === "--logs") args.logs = true;
    else if (a === "--install-service") args.installService = true;
    else if (a === "--foreground" || a === "-f") args.foreground = true;
    else if (a === "--no-open") args.open = false;
    else if (a === "--help" || a === "-h") args.help = true;
    else if (a === "--port") args.port = parseInt(argv[++i], 10);
    else if (a.startsWith("--port=")) args.port = parseInt(a.split("=")[1], 10);
  }
  return args;
}

function help() {
  console.log(`🧬  dna ui — Mesh Visualization Dashboard

Usage:
  dna ui                Start dashboard at http://localhost:4893
  dna ui --port 5000    Use custom port
  dna ui --stop         Stop running service
  dna ui --status       Show service status
  dna ui --logs         Tail logs
  dna ui --install-service
                        Install oxmgr launchd service and register DNA UI
  dna ui --foreground   Run inline (Ctrl+C to exit)
  dna ui --no-open      Don't auto-open browser

Service is managed via oxmgr (process name: ${SERVICE_NAME}).`);
}

function ensureGuiBuilt(): boolean {
  if (!existsSync(GUI_DIR)) {
    console.error(`✗ GUI directory not found: ${GUI_DIR}`);
    return false;
  }
  if (!existsSync(join(GUI_DIR, "node_modules"))) {
    console.log("📦 Installing GUI dependencies (one-time)…");
    const r = spawnSync("npm", ["install"], { cwd: GUI_DIR, stdio: "inherit" });
    if (r.status !== 0) return false;
  }
  if (!existsSync(join(GUI_DIR, "dist", "client", "index.html"))) {
    console.log("🔨 Building GUI bundle (one-time)…");
    const r = spawnSync("npm", ["run", "build"], { cwd: GUI_DIR, stdio: "inherit" });
    if (r.status !== 0) return false;
  }
  return true;
}

function oxmgr(...argv: string[]): { code: number; out: string; err: string } {
  const r = spawnSync(process.execPath, [OXMGR_JS, ...argv], {
    cwd: GUI_DIR,
    encoding: "utf-8",
  });
  return {
    code: r.status ?? 1,
    out: r.stdout || "",
    err: r.stderr || "",
  };
}

function isRunning(): boolean {
  const r = oxmgr("status", SERVICE_NAME);
  if (r.code !== 0) return false;
  return /running|online|active/i.test(r.out);
}

function openBrowser(url: string) {
  const cmd =
    platform() === "darwin" ? "open" :
    platform() === "win32" ? "start" : "xdg-open";
  try { spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref(); } catch {}
}

function startForeground(port: number) {
  console.log(`🧬 Starting DNA UI at http://localhost:${port}  (foreground mode)`);
  const r = spawnSync(process.execPath, [TSX_CLI, SERVER_PATH], {
    cwd: GUI_DIR,
    stdio: "inherit",
    env: { ...process.env, PORT: String(port), NODE_ENV: "production" },
  });
  process.exit(r.status ?? 0);
}

function startManaged(port: number, openBrowserFlag: boolean) {
  // If already running, just tell the user
  if (isRunning()) {
    console.log(`✓ DNA UI already running. Visit http://localhost:${port}`);
    if (openBrowserFlag) openBrowser(`http://localhost:${port}`);
    return;
  }

  // Use absolute node + tsx paths. launchd does not inherit an interactive
  // shell PATH, so relying on `#!/usr/bin/env node` makes reboot recovery fail.
  const cmdString = `"${process.execPath}" "${TSX_CLI}" "${SERVER_PATH}"`;
  const r = oxmgr(
    "start",
    "--name", SERVICE_NAME,
    "--cwd", GUI_DIR,
    "--env", `PORT=${port}`,
    "--env", "NODE_ENV=production",
    "--env", `DNA_DATA=${process.env.DNA_DATA || join(homedir(), ".openclaw", ".dna")}`,
    "--health-cmd", `/usr/bin/curl -fsS http://127.0.0.1:${port}/`,
    "--health-interval", "30",
    "--health-timeout", "5",
    "--health-max-failures", "3",
    "--restart", "always",
    cmdString,
  );

  if (r.code !== 0) {
    console.error("✗ oxmgr start failed:");
    if (r.err) console.error(r.err);
    if (r.out) console.error(r.out);
    console.error("\nTip: try `dna ui --foreground` to run inline and see errors.");
    process.exit(1);
  }
  console.log(`✓ DNA UI started → http://localhost:${port}`);
  console.log(`  Process name: ${SERVICE_NAME}`);
  console.log(`  Logs: dna ui --logs`);
  console.log(`  Stop: dna ui --stop`);
  if (openBrowserFlag) {
    setTimeout(() => openBrowser(`http://localhost:${port}`), 800);
  }
}

function stop() {
  const r = oxmgr("stop", SERVICE_NAME);
  if (r.code === 0) {
    console.log(`✓ DNA UI stopped.`);
  } else {
    console.error(r.err || r.out || "stop failed");
    process.exit(1);
  }
  // Also remove from registry so a subsequent start with a different port works cleanly
  oxmgr("rm", SERVICE_NAME);
}

function status() {
  const r = oxmgr("status", SERVICE_NAME);
  process.stdout.write(r.out);
  if (r.err) process.stderr.write(r.err);
  process.exit(r.code);
}

function logs() {
  // Stream logs (oxmgr log -f tails)
  const child = spawn(process.execPath, [OXMGR_JS, "log", SERVICE_NAME, "-f"], {
    cwd: GUI_DIR,
    stdio: "inherit",
  });
  child.on("exit", (c) => process.exit(c ?? 0));
}

function installService(port: number) {
  if (!ensureGuiBuilt()) process.exit(1);

  const install = oxmgr("service", "install");
  if (install.out) process.stdout.write(install.out);
  if (install.err) process.stderr.write(install.err);
  if (install.code !== 0) process.exit(install.code);

  // On macOS, make the LaunchAgent active immediately. oxmgr prints startup
  // instructions, but `dna ui --install-service` should be a complete one-shot.
  if (platform() === "darwin") {
    const uid = String(process.getuid?.() ?? "");
    const plist = join(homedir(), "Library", "LaunchAgents", "io.oxmgr.daemon.plist");
    spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "ignore" });
    spawnSync("launchctl", ["enable", `gui/${uid}/io.oxmgr.daemon`], { stdio: "ignore" });
    spawnSync("launchctl", ["kickstart", "-k", `gui/${uid}/io.oxmgr.daemon`], { stdio: "ignore" });
  }

  // Register the UI itself with reboot-safe absolute paths. If it already
  // exists, replace it so older PATH-dependent entries are repaired.
  oxmgr("rm", SERVICE_NAME);
  startManaged(port, false);

  const doctor = oxmgr("doctor");
  if (doctor.out) process.stdout.write(doctor.out);
  if (doctor.err) process.stderr.write(doctor.err);
  console.log(`\n✓ DNA UI service installed. Visit http://localhost:${port}`);
}

// ── main ──
const args = parseArgs(process.argv.slice(2));
if (args.help) { help(); process.exit(0); }

if (args.stop) { stop(); process.exit(0); }
if (args.status) { status(); /* exits */ }
if (args.logs) { logs(); /* exits */ }
if (args.installService) { installService(args.port); process.exit(0); }

if (!ensureGuiBuilt()) process.exit(1);

if (args.foreground) startForeground(args.port);
else startManaged(args.port, args.open);
