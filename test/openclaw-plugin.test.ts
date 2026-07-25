import { describe, it } from "node:test";
import assert from "node:assert/strict";
import plugin from "../openclaw/index.ts";

type Handler = (
  event: { toolName: string; params: Record<string, unknown> },
  context: { agentId?: string },
) => unknown;

function beforeToolCallHandler(): Handler {
  let handler: Handler | undefined;
  plugin.register({
    on(name: string, candidate: Handler) {
      if (name === "before_tool_call") handler = candidate;
    },
    registerHook() {},
    registerTool() {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  } as never);
  assert.ok(handler);
  return handler;
}

describe("openclaw-dna before_tool_call", () => {
  it("injects AGENT_ID into legacy OpenClaw exec calls", () => {
    const handler = beforeToolCallHandler();
    const result = handler(
      {
        toolName: "exec",
        params: { command: "true", env: { KEEP: "yes" } },
      },
      { agentId: "travel" },
    );
    assert.deepEqual(result, {
      params: {
        command: "true",
        env: { KEEP: "yes", AGENT_ID: "travel" },
      },
    });
  });

  it("does not rewrite Codex approval-bound exec params", () => {
    const handler = beforeToolCallHandler();
    const result = handler(
      {
        toolName: "exec",
        params: {
          cmd: "true",
          workdir: "/tmp",
          sandbox_permissions: "use_default",
        },
      },
      { agentId: "main" },
    );
    assert.deepEqual(result, {});
  });
});
