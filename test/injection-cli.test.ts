import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const dnaCli = fileURLToPath(new URL("../bin/dna", import.meta.url));

describe("dna injection CLI", () => {
  let testHome = "";
  let dnaData = "";

  before(() => {
    testHome = mkdtempSync(join(tmpdir(), "agentic-dna-injection-"));
    dnaData = join(testHome, ".openclaw", ".dna");
    const injectionDir = join(dnaData, "injections");
    mkdirSync(injectionDir, { recursive: true });
    writeFileSync(
      join(injectionDir, "base.dna"),
      [
        "---",
        "id: base",
        "title: Base policy",
        "trigger: always",
        "---",
        "",
        "Base injection body.",
      ].join("\n"),
    );
    writeFileSync(
      join(injectionDir, "interactive.md"),
      [
        "---",
        "id: interactive",
        "title: Interactive policy",
        "trigger: interactive",
        "---",
        "",
        "Interactive injection body.",
      ].join("\n"),
    );
  });

  after(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  function dna(...args: string[]) {
    return execFileSync(dnaCli, args, {
      encoding: "utf8",
      env: { ...process.env, HOME: testHome },
    });
  }

  it("lists both .dna and .md injection files", () => {
    const output = dna("injection", "--list");
    assert.match(output, /Prompt Injections — 2 entries/);
    assert.match(output, /base\s+always\s+Base policy/);
    assert.match(output, /interactive\s+interactive\s+Interactive policy/);
  });

  it("shows a .dna injection by slug", () => {
    assert.match(dna("injection", "base"), /Base injection body\./);
  });
});
