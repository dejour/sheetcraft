import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import app, { consumeAiQuota, readLimitedJson, readMusicXmlUpload } from "../src/worker/index";

test("AI limits apply per user and globally, and reset on a new day", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("create table ai_daily_usage (day text, subject text, request_count integer, primary key (day, subject))");
  const db = {
    prepare(sql: string) {
      return { bind(...params: Array<string | number>) { return { async run() {
        const result = sqlite.prepare(sql).run(...params);
        return { meta: { changes: Number(result.changes) } };
      } }; } };
    }
  } as unknown as D1Database;
  const env = { DB: db, AI_DAILY_USER_LIMIT: 2, AI_DAILY_GLOBAL_LIMIT: 3 };
  try {
    await consumeAiQuota(env, "alice", "2026-09-24");
    await consumeAiQuota(env, "alice", "2026-09-24");
    await assert.rejects(consumeAiQuota(env, "alice", "2026-09-24"), { status: 429 });
    await consumeAiQuota(env, "bob", "2026-09-24");
    await assert.rejects(consumeAiQuota(env, "bob", "2026-09-24"), { status: 429 });
    await consumeAiQuota(env, "alice", "2026-09-25");
  } finally {
    sqlite.close();
  }
});

test("AI JSON rejects oversized and malformed requests", async () => {
  const request = (body: string) => new Request("https://example.test/api", { method: "POST", body });
  await assert.rejects(readLimitedJson(request("x".repeat(64 * 1024 + 1))), { status: 413 });
  await assert.rejects(readLimitedJson(request("{")), { status: 400 });
});

test("MusicXML upload accepts a small file and rejects oversized input", async () => {
  const form = new FormData();
  form.append("file", new File(["<score-partwise/>"], "example.musicxml"));
  const uploaded = await readMusicXmlUpload(new Request("https://example.test/api/projects", {
    method: "POST",
    body: form
  }));
  assert.equal(uploaded.musicxml, "<score-partwise/>");
  await assert.rejects(readMusicXmlUpload(new Request("https://example.test/api/projects", {
    method: "POST",
    body: "x".repeat(4 * 1024 * 1024 + 1)
  })), { status: 413 });
});

test("API responses do not authorize arbitrary cross-origin credentials", async () => {
  const response = await app.fetch(new Request("https://example.test/api/auth/get-session", {
    headers: { Origin: "https://untrusted.example" }
  }), {});
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});
