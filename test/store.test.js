const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createStore } = require("../src/store");

function tempPath(name) {
  return path.join(os.tmpdir(), "oa-shell-store-" + process.pid + "-" + name + ".json");
}

test("overwriting an existing data file keeps the latest data", () => {
  const filePath = tempPath("overwrite");
  const store = createStore(filePath);
  try {
    store.save({ settings: { workStart: "08:30" } });
    assert.equal(store.load().settings.workStart, "08:30");
    store.save({ settings: { workStart: "10:00" } });
    assert.equal(store.load().settings.workStart, "10:00");
    assert.equal(fs.existsSync(filePath + ".tmp"), false);
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(filePath + ".tmp", { force: true });
  }
});

test("a corrupt data file loads as empty instead of throwing", () => {
  const filePath = tempPath("corrupt");
  const store = createStore(filePath);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, "{not json", "utf8");
    const data = store.load();
    assert.equal(typeof data.settings.oaUrl, "string");
    assert.equal(Array.isArray(data.tasks), true);
  } finally {
    fs.rmSync(filePath, { force: true });
  }
});

test("saving creates missing parent directories", () => {
  const filePath = path.join(os.tmpdir(), "oa-shell-store-" + process.pid + "-nested", "sub", "data.json");
  const store = createStore(filePath);
  try {
    store.save({ settings: { workStart: "09:00" } });
    assert.equal(store.load().settings.workStart, "09:00");
  } finally {
    fs.rmSync(path.dirname(path.dirname(filePath)), { force: true, recursive: true });
  }
});
