import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  compileWorkspaceContext,
  containsSecret,
  expandDirectives,
  loadConfig,
  pickPromptDnaMatch,
  splitArgs
} from "../scripts/context-core.mjs";

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "agentic-dna-codex-"));
  mkdirSync(join(root, ".git"));
  return root;
}

test("loads OpenClaw bootstrap files but excludes MEMORY.md", () => {
  const root = workspace();
  writeFileSync(join(root, "SOUL.md"), "# Soul\nStay precise.");
  writeFileSync(join(root, "USER.md"), "# User\nExis");
  writeFileSync(join(root, "MEMORY.md"), "access_token=do-not-inject-ever");
  writeFileSync(join(root, "workspace.context.json"), JSON.stringify({
    includeDnaInjections: false
  }));

  const result = compileWorkspaceContext(root);
  assert.match(result.context, /Stay precise/);
  assert.match(result.context, /Exis/);
  assert.doesNotMatch(result.context, /do-not-inject-ever/);
  assert.doesNotMatch(result.context, /MEMORY\.md/);
});

test("registers main-thread hooks but no SubagentStart hook", () => {
  const hooks = JSON.parse(readFileSync(
    new URL("../hooks/hooks.json", import.meta.url),
    "utf8"
  ));
  assert.deepEqual(
    Object.keys(hooks.hooks),
    ["SessionStart", "UserPromptSubmit"],
  );
  assert.equal(hooks.hooks.SubagentStart, undefined);
});

test("prompt DNA lookup accepts exact substring or explicit slug matches only", () => {
  const exact = {
    id: "dna://middleware/dokploy",
    signals: { substring: 1, semantic: 0.2 },
  };
  const semanticOnly = {
    id: "dna://middleware/qbittorrent",
    signals: { substring: 0, semantic: 0.9 },
  };
  assert.equal(pickPromptDnaMatch([semanticOnly, exact]), exact);
  assert.equal(pickPromptDnaMatch([semanticOnly]), null);
  assert.equal(
    pickPromptDnaMatch([exact], "把这个站点部署到 Dokploy"),
    exact,
  );
  assert.equal(
    pickPromptDnaMatch([semanticOnly], "deploy this site"),
    null,
  );
});

test("prompt DNA context allows environment variable references, not values", () => {
  assert.equal(containsSecret("x-api-key: $DOKPLOY_API_KEY"), false);
  assert.equal(containsSecret("api_key: actual-secret-value"), true);
});

test("expands a registered CLI without a shell", () => {
  const root = workspace();
  const cli = join(root, "reader.mjs");
  writeFileSync(cli, "#!/usr/bin/env node\nprocess.stdout.write(process.argv.slice(2).join(':'));\n");
  const config = {
    ...loadConfig(root),
    includeDnaInjections: false,
    commands: {
      reader: { executable: process.execPath, maxChars: 1000 }
    }
  };
  const value = expandDirectives(`before {{cli reader "${cli}" show hello}} after`, config, root);
  assert.match(value, /show:hello/);
});

test("rejects shell metacharacters", () => {
  assert.throws(() => splitArgs("show | sh"), /metacharacters/);
  assert.throws(() => splitArgs("show $(whoami)"), /metacharacters/);
});

test("protects directives inside code", () => {
  const root = workspace();
  const config = { ...loadConfig(root), includeDnaInjections: false };
  const source = "Example: `{{dna spec --global}}`";
  assert.equal(expandDirectives(source, config, root), source);
});

test("skips configured files containing likely secrets", () => {
  const root = workspace();
  writeFileSync(join(root, "SOUL.md"), "api_key=abcdefghijklmnopqrstuvwxyz");
  writeFileSync(join(root, "workspace.context.json"), JSON.stringify({
    includeDnaInjections: false
  }));
  const result = compileWorkspaceContext(root);
  assert.doesNotMatch(result.context, /abcdefghijklmnopqrstuvwxyz/);
  assert.match(result.context, /potential secret detected/);
});
