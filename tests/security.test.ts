import test from "node:test";
import assert from "node:assert/strict";
import app from "../src/worker/index";

test("API responses do not authorize arbitrary cross-origin credentials", async () => {
  const response = await app.fetch(new Request("https://example.test/api/auth/get-session", {
    headers: { Origin: "https://untrusted.example" }
  }), {});
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.equal(response.headers.get("access-control-allow-credentials"), null);
});
