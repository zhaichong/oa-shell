const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../src/store");

test("measures synchronous local saves", () => {
  const filePath = path.join(os.tmpdir(), "oa-shell-store-" + process.pid + ".json");
  const store = createStore(filePath);
  const data = store.load();
  const started = process.hrtime.bigint();
  let latest = data;
  for (let index = 0; index < 40; index += 1) {
    latest = store.save(latest);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  console.log("store.save x40 ms " + elapsedMs.toFixed(1));
  assert.equal(typeof latest.settings.oaUrl, "string");
  fs.rmSync(filePath, { force: true });
});
