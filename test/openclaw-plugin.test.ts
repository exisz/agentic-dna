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

function promptHook() {
  let handler: ((event: unknown, ctx: { trigger?: string }) => unknown) | undefined;
  plugin.register({
    on(name: string, fn: typeof handler) {
      if (name === "before_prompt_build") handler = fn;
    },
    registerHook() {},
    registerTool() {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as never);
  assert.ok(handler);
  return handler;
}

describe("openclaw-dna tool compatibility", () => {
  it("does not register hooks that rewrite Codex exec calls", () => {
    const names = registeredHookNames();
    assert.equal(names.includes("before_tool_call"), false);
    assert.equal(names.includes("resolve_exec_env"), false);
    assert.equal(names.includes("before_prompt_build"), true);
  });

  it("expands DNA directives inside global prompt injections", () => {
    const result = promptHook()({}, { trigger: "interactive" }) as {
      appendSystemContext: string;
    };
    assert.match(result.appendSystemContext, /DNA Toolbox \(global\)/);
    assert.match(result.appendSystemContext, /- roblocks: .*credential/i);
    assert.doesNotMatch(result.appendSystemContext, /\{\{dna tool --inject\}\}/);
  });
});
