import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { backendEnv } = require("../electron/backend-env.cjs");

test("source runs may opt into backend debug mode", () => {
  const env = backendEnv({ LUDO_DEBUG: "1", KEEP: "yes" }, "127.0.0.1", 8723, false);
  assert.equal(env.LUDO_DEBUG, "1");
  assert.equal(env.KEEP, "yes");
  assert.equal(env.ROMM_HOST, "127.0.0.1");
  assert.equal(env.ROMM_PORT, "8723");
});

test("packaged builds cannot inherit backend debug mode", () => {
  const original = { LUDO_DEBUG: "1", KEEP: "yes" };
  const env = backendEnv(original, "127.0.0.1", 9000, true);
  assert.equal(env.LUDO_DEBUG, undefined);
  assert.equal(env.KEEP, "yes");
  assert.equal(env.ROMM_PORT, "9000");
  assert.equal(original.LUDO_DEBUG, "1", "the parent environment is not mutated");
});
