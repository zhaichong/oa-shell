const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup({ visible = false, minimized = false, foreground = false, flash } = {}) {
  const state = { visible, minimized, images: [], flashes: [], timers: [], intervals: new Map() };
  const window = {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
    showInactive: () => { state.visible = true; },
    show: () => { state.visible = true; },
    minimize: () => { state.minimized = true; },
    setSkipTaskbar() {},
    setOverlayIcon: image => { state.overlay = image; },
    flashFrame: enabled => state.flashes.push(enabled)
  };
  const fakeFlasher = {
    foreground: async () => foreground ? "1" : "2",
    flash: flash || (async () => { state.flashes.push(true); return "ok"; }),
    stop: async () => { state.flashes.push(false); }
  };
  const context = vm.createContext({
    require(name) {
      if (name === "electron") return { app: { requestSingleInstanceLock: () => false, quit() {} } };
      if (name === "./win-flash") return { createWinFlash: () => fakeFlasher };
      return require(name.startsWith("./") ? "../src/" + name.slice(2) : name);
    },
    __dirname: path.resolve(__dirname, "../src"),
    process,
    Buffer,
    URL,
    setTimeout(fn, delay) {
      if (delay <= 200) queueMicrotask(fn);
      else state.timers.push(fn);
      return state.timers.length;
    },
    clearTimeout() {},
    setInterval(fn, delay) {
      const id = state.intervals.size + 1;
      state.intervals.set(id, { fn, delay });
      return id;
    },
    clearInterval(id) { state.intervals.delete(id); }
  });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, "../src/main.js"), "utf8"), context);
  context.fakeWindow = window;
  context.fakeTray = { setImage: image => state.images.push(image), setToolTip: text => { state.tooltip = text; } };
  vm.runInContext('mainWindow = fakeWindow; tray = fakeTray; trayIcon = "normal"; trayAlertIcon = "unread"; messageOverlayIcon = "unread"; data = { settings: {}, days: {}, reminders: {} };', context);
  return { state, run: expression => vm.runInContext(expression, context) };
}

test("new messages keep a hidden window hidden and slowly alternate complete tray icons", async () => {
  const { state, run } = setup();
  await run("attractAttention()");
  assert.equal(state.visible, false);
  assert.equal(state.minimized, false);
  assert.equal(state.intervals.size, 1);
  assert.equal(state.images.at(-1), "unread");
  const timer = [...state.intervals.values()][0];
  assert.equal(timer.delay, 1000);
  timer.fn();
  timer.fn();
  assert.deepEqual(state.images, ["unread", "normal", "unread"]);
  await run("attractAttention()");
  assert.equal(state.intervals.size, 1);
  run("stopAttention()");
  assert.equal(state.intervals.size, 0);
  assert.equal(state.images.at(-1), "normal");
  timer.fn();
  assert.equal(state.images.at(-1), "normal");
});

test("minimized windows stay minimized while the taskbar is notified", async () => {
  const { state, run } = setup({ visible: false, minimized: true });
  await run("attractAttention()");
  assert.equal(state.visible, false);
  assert.equal(state.minimized, true);
  assert.ok(state.flashes.includes(true));
  assert.equal(state.overlay, "unread");
});

test("taskbar flashing continues until the user acknowledges the reminder", async () => {
  const { state, run } = setup({ visible: true });
  await run("attractAttention()");
  assert.equal(state.flashes.at(-1), true);
  assert.equal(state.timers.length, 0);
  assert.equal(state.images.at(-1), "unread");
  assert.equal(state.overlay, "unread");
  run("stopAttention()");
  assert.equal(state.flashes.at(-1), false);
  assert.equal(state.images.at(-1), "normal");
  assert.equal(state.overlay, null);
});

test("messages in the foreground do not start background reminders", async () => {
  const { state, run } = setup({ visible: true, foreground: true });
  await run("attractAttention()");
  assert.equal(state.images.length, 0);
  assert.equal(state.flashes.length, 0);
});

test("acknowledging while a foreground check is pending cancels the reminder", async () => {
  const { state, run } = setup({ visible: true });
  const result = run("attractAttention()");
  run("stopAttention()");
  await result;
  assert.equal(state.images.at(-1), "normal");
  assert.equal(state.overlay, null);
  assert.ok(!state.flashes.includes(true));
});

test("a late flashing failure cannot restart an acknowledged reminder", async () => {
  let rejectFlash;
  const { state, run } = setup({ visible: true, flash: () => new Promise((_resolve, reject) => { rejectFlash = reject; }) });
  const result = run("attractAttention()");
  await new Promise(resolve => setImmediate(resolve));
  run("stopAttention()");
  rejectFlash(new Error("helper closed"));
  await result;
  assert.ok(!state.flashes.includes(true));
});
