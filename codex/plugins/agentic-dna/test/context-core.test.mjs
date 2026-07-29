import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  compileWorkspaceContext,
  expandDirectives,
  loadConfig,
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

test("does not register a SubagentStart hook", () => {
  const hooks = JSON.parse(readFileSync(
    new URL("../hooks/hooks.json", import.meta.url),
    "utf8"
  ));
  assert.deepEqual(Object.keys(hooks.hooks), ["SessionStart"]);
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
