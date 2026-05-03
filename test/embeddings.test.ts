/**
 * Smoke test for the embeddings library — verifies the math + index logic
 * WITHOUT hitting the model (which would require a 22MB download in CI).
 *
 * Real semantic-quality validation lives in the manual smoke commands documented
 * in the search-cli help.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildEmbedText,
  contentHashOf,
  cosineSim,
} from "../lib/embeddings.ts";

test("buildEmbedText: combines title + tokenized id + body + tags", () => {
  const text = buildEmbedText({
    id: "test-driven",
    title: "Test-Driven",
    body: "Tests come before code.",
    tags: ["quality", "engineering"],
  });
  assert.match(text, /Test-Driven/);
  assert.match(text, /test driven/); // id tokenized
  assert.match(text, /Tests come before code\./);
  assert.match(text, /quality engineering/);
});

test("buildEmbedText: falls back to fields when no body", () => {
  const text = buildEmbedText({
    id: "x",
    fields: { description: "describes a thing", purpose: "for testing" },
  });
  assert.match(text, /describes a thing/);
  assert.match(text, /for testing/);
});

test("contentHashOf: stable + different for different content", () => {
  const a = contentHashOf("hello world");
  const b = contentHashOf("hello world");
  const c = contentHashOf("hello worlD");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.equal(a.length, 16);
});

test("cosineSim: identical vectors == 1, orthogonal == 0, opposite == -1", () => {
  const a = [1, 0, 0];
  const b = [1, 0, 0];
  const c = [0, 1, 0];
  const d = [-1, 0, 0];
  assert.equal(cosineSim(a, b), 1);
  assert.equal(cosineSim(a, c), 0);
  assert.equal(cosineSim(a, d), -1);
});

test("cosineSim: handles unit-normalized 384-d-style vectors", () => {
  const dim = 384;
  const v = new Array(dim).fill(0).map((_, i) => Math.sin(i));
  const norm = Math.sqrt(v.reduce((a, x) => a + x * x, 0));
  const u = v.map((x) => x / norm);
  // Self-similarity ≈ 1
  assert.ok(Math.abs(cosineSim(u, u) - 1) < 1e-9);
});

test("cosineSim: mismatched dimensions return 0 (defensive)", () => {
  assert.equal(cosineSim([1, 0], [1, 0, 0]), 0);
});
