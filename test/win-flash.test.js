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

function makeFakeChild() {
  const stdout = new EventEmitter();
  const handlers = {};
  const child = {
    stdout,
    stdin: { writable: true, write() {} },
    on(event, handler) { handlers[event] = handler; },
    kill() {},
    handlers
  };
  return child;
}

test("a spawn failure settles the pending request instead of throwing", async () => {
  let child = null;
  const flash = createWinFlash(path.join(__dirname, "missing.ps1"), {
    timeoutMs: 5000,
    spawn() {
      child = makeFakeChild();
      process.nextTick(() => child.stdout.emit("data", Buffer.from("ready\n")));
      return child;
    }
  });
  const pending = flash.flash("5");
  await new Promise((resolve) => setImmediate(resolve));
  child.handlers.error(new Error("spawn powershell.exe ENOENT"));
  assert.equal(await pending, "");
  flash.close();
});

test("close() settles a waiting request instead of leaving it to time out", async () => {
  const flash = createWinFlash(path.join(__dirname, "missing.ps1"), {
    timeoutMs: 5000,
    spawn() {
      return makeFakeChild();
    }
  });
  const started = Date.now();
  const pending = flash.flash("5");
  await new Promise((resolve) => setTimeout(resolve, 10));
  flash.close();
  assert.equal(await pending, "");
  assert.ok(Date.now() - started < 1000, "should settle on close, not on timeout");
});

test("a failing stdin write settles with an empty string instead of rejecting", async () => {
  const flash = createWinFlash(path.join(__dirname, "missing.ps1"), {
    timeoutMs: 5000,
    spawn() {
      const stdout = new EventEmitter();
      const child = {
        stdout,
        stdin: { writable: true, write() { throw new Error("EPIPE"); } },
        on() {},
        kill() {}
      };
      process.nextTick(() => stdout.emit("data", Buffer.from("ready\n")));
      return child;
    }
  });
  assert.equal(await flash.flash("5"), "");
  flash.close();
});

test("a malformed window handle never reaches the helper", async () => {
  let spawned = 0;
  const flash = createWinFlash(path.join(__dirname, "missing.ps1"), {
    timeoutMs: 5000,
    spawn() {
      spawned += 1;
      return makeFakeChild();
    }
  });
  assert.equal(await flash.flash("timeout"), "");
  assert.equal(await flash.stop("12x"), "");
  assert.equal(await flash.setIcon("NaN", "0"), "");
  assert.equal(spawned, 0);
  flash.close();
});

test("a stale partial line from a dead helper does not poison the next one", async () => {
  const children = [];
  const flash = createWinFlash(path.join(__dirname, "missing.ps1"), {
    timeoutMs: 5000,
    spawn() {
      const child = makeFakeChild();
      children.push(child);
      return child;
    }
  });
  const first = flash.flash("5");
  await new Promise((resolve) => setImmediate(resolve));
  children[0].stdout.emit("data", Buffer.from("ok 12"));
  children[0].handlers.exit();
  assert.equal(await first, "");
  // A fresh helper starts clean: its "ready" is recognized, not glued
  // to the stale partial line.
  const second = flash.flash("6");
  await new Promise((resolve) => setImmediate(resolve));
  children[1].stdout.emit("data", Buffer.from("ready\n"));
  children[1].stdout.emit("data", Buffer.from("ok 6\n"));
  assert.equal(await second, "ok 6");
  flash.close();
});
