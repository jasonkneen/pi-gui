import test from "node:test";
import assert from "node:assert/strict";
import { buildTitlePrompt } from "../dist/thread-title-generator.js";

test("buildTitlePrompt caps an oversized first message", () => {
  const prompt = buildTitlePrompt("x".repeat(50_000));
  const match = /<user_message>\n([\s\S]*)\n<\/user_message>/.exec(prompt);
  assert.ok(match, "title prompt should contain the user message block");
  assert.equal(match[1]?.length, 4_000);
});

test("buildTitlePrompt keeps short messages intact", () => {
  const prompt = buildTitlePrompt("fix the flaky timeline test");
  assert.ok(prompt.includes("<user_message>\nfix the flaky timeline test\n</user_message>"));
});
