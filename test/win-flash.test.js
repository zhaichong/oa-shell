const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const { createWinFlash } = require("../src/win-flash");

test("a timed out helper response cannot satisfy the next command", async () => {
  let child = null;
  const flash = createWinFlash(path.join(__dirname, "missing.ps1"), {
    timeoutMs: 30,
    spawn() {
      const stdout = new EventEmitter();
      child = {
        stdout,
        stdin: { writable: true, write() {} },
        on() {},
        kill() {}
      };
      process.nextTick(() => stdout.emit("data", Buffer.from("ready\n")));
      return child;
    }
  });
  assert.equal(await flash.flash("5"), "timeout");
  child.stdout.emit("data", Buffer.from("ok late\n"));
  const second = flash.foreground();
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.emit("data", Buffer.from("99\n"));
  assert.equal(await second, "99");
  flash.close();
});

test("windows helper reports a numeric foreground window", { timeout: 8000, skip: process.platform !== "win32" }, async () => {
  const flash = createWinFlash(path.join(__dirname, "../resources/win-flash.ps1"));
  try {
    const value = await flash.foreground();
    assert.match(String(value), /^\d+$/);
  } finally {
    flash.close();
  }
});
