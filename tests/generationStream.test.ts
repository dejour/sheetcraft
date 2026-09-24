import test from "node:test";
import assert from "node:assert/strict";
import { readGenerationLines } from "../src/worker/generationStream";

test("generation emits complete measures before the stream ends, including split lines", async () => {
  const received: unknown[] = [];
  async function* chunks() {
    yield '{"type":"create_';
    assert.equal(received.length, 0);
    yield 'score"}\n{"type":"replace_measures"';
    assert.deepEqual(received, [{ type: "create_score" }]);
    yield '}\n{"done":true}';
  }
  await readGenerationLines(chunks(), value => received.push(value));
  assert.equal(received.length, 2);
});

test("generation rejects truncation and content after completion", async () => {
  for (const text of ['{"type":"create_score"}\n', '{"type":', '{"done":true}\n{}']) {
    async function* chunks() { yield text; }
    await assert.rejects(readGenerationLines(chunks(), () => {}));
  }
});
