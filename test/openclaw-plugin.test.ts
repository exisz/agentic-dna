import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin from "../openclaw/index.ts";

function registeredHookNames(): string[] {
  const names: string[] = [];
  plugin.register({
    on(name: string) {
      names.push(name);
    },
    registerHook() {},
    registerTool() {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as never);
  return names;
}

describe("openclaw-dna tool compatibility", () => {
  it("does not register hooks that rewrite Codex exec calls", () => {
    const names = registeredHookNames();
    assert.equal(names.includes("before_tool_call"), false);
    assert.equal(names.includes("resolve_exec_env"), false);
    assert.equal(names.includes("before_prompt_build"), true);
  });
});
