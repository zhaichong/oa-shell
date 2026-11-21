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
    // The damaged bytes are kept aside instead of being wiped by the
    // next save: the corrupt copy must still exist.
    const kept = fs.readdirSync(path.dirname(filePath)).filter((name) => name.startsWith(path.basename(filePath) + ".corrupt-"));
    assert.equal(kept.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(filePath), kept[0]), "utf8"), "{not json");
    store.save(data);
    assert.equal(fs.readFileSync(path.join(path.dirname(filePath), kept[0]), "utf8"), "{not json");
  } finally {
    fs.readdirSync(path.dirname(filePath))
      .filter((name) => name.startsWith(path.basename(filePath)))
      .forEach((name) => fs.rmSync(path.join(path.dirname(filePath), name), { force: true }));
  }
});

test("a corrupt data file falls back to the last good backup", () => {
  const filePath = tempPath("corrupt-bak");
  const store = createStore(filePath);
  try {
    store.save({ settings: { workStart: "08:30" } });
    store.save({ settings: { workStart: "08:30" } });
    assert.equal(fs.existsSync(filePath + ".bak"), true);
    fs.writeFileSync(filePath, "{broken", "utf8");
    const data = store.load();
    assert.equal(data.settings.workStart, "08:30");
    store.save(data);
    assert.equal(store.load().settings.workStart, "08:30");
  } finally {
    fs.readdirSync(path.dirname(filePath))
      .filter((name) => name.startsWith(path.basename(filePath)))
      .forEach((name) => fs.rmSync(path.join(path.dirname(filePath), name), { force: true }));
  }
});

test("a stale tmp file is removed on save", () => {
  const filePath = tempPath("stale-tmp");
  const store = createStore(filePath);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath + ".tmp", "junk", "utf8");
    store.save({ settings: { workStart: "08:30" } });
    assert.equal(fs.existsSync(filePath + ".tmp"), false);
    assert.equal(store.load().settings.workStart, "08:30");
  } finally {
    fs.rmSync(filePath, { force: true });
    fs.rmSync(filePath + ".tmp", { force: true });
    fs.rmSync(filePath + ".bak", { force: true });
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
