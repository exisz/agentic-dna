import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";

const repoRoot = resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function renderRuntimeArtifact(artifact: string): string {
  const home = temporaryDirectory("openclaw-dna-runtime-");
  const injections = join(home, ".openclaw", ".dna", "injections");
  const bin = join(home, "bin");
  mkdirSync(injections, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(injections, "base.dna"),
    "---\nid: base\ntrigger: always\n---\n\n{{dna tool --inject}}\n",
  );
  const dna = join(bin, "dna");
  writeFileSync(
    dna,
    "#!/bin/sh\nprintf '%s\\n' '## DNA Toolbox (global)' '- roblocks: Git-backed credential vault'\n",
  );
  chmodSync(dna, 0o755);

  const runner = `
    const plugin = (await import(${JSON.stringify(pathToFileURL(artifact).href)})).default;
    let handler;
    plugin.register({
      on(name, fn) { if (name === "before_prompt_build") handler = fn; },
      registerHook() {}, registerTool() {},
      logger: { info() {}, warn() {}, error() {}, debug() {} },
    });
    const result = handler({}, { trigger: "interactive" });
    process.stdout.write(result.appendSystemContext);
  `;
  return execFileSync(process.execPath, ["--input-type=module", "-e", runner], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, DNA_DATA: join(home, ".openclaw", ".dna"), PATH: `${bin}:${process.env.PATH}` },
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("published OpenClaw runtime artifact", () => {
  it("hydrates the built dist artifact with the global toolbox", () => {
    const output = renderRuntimeArtifact(join(repoRoot, "openclaw", "dist", "index-codex-safe.js"));
    assert.match(output, /DNA Toolbox \(global\)/);
    assert.match(output, /roblocks: .*credential/i);
    assert.doesNotMatch(output, /\{\{dna tool --inject\}\}/);
  });

  it("ships the same hydrated behavior in the npm tarball", () => {
    const packDirectory = temporaryDirectory("openclaw-dna-pack-");
    const packJson = execFileSync("npm", ["pack", join(repoRoot, "openclaw"), "--json"], {
      cwd: packDirectory,
      encoding: "utf8",
    });
    const [{ filename }] = JSON.parse(packJson) as Array<{ filename: string }>;
    execFileSync("tar", ["-xzf", filename], { cwd: packDirectory });
    const artifact = join(packDirectory, "package", "dist", "index-codex-safe.js");
    assert.match(readFileSync(artifact, "utf8"), /expandDnaDirectives/);
    const output = renderRuntimeArtifact(artifact);
    assert.match(output, /DNA Toolbox \(global\)/);
    assert.match(output, /roblocks: .*credential/i);
    assert.doesNotMatch(output, /\{\{dna tool --inject\}\}/);
  });
});
