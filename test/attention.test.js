const test = require("node:test");
const assert = require("node:assert/strict");
const { createAttention } = require("../src/attention");

function setup({ visible = false, minimized = false, foreground = false, flash, windowIcon = "" } = {}) {
  const state = { visible, minimized, images: [], icons: [], flashes: [], intervals: new Map() };
  const window = {
    isDestroyed: () => false,
    isVisible: () => state.visible,
    isMinimized: () => state.minimized,
    getNativeWindowHandle: () => Buffer.from([1, 0, 0, 0]),
    flashFrame: (enabled) => state.flashes.push(enabled)
  };
  const tray = {
    setImage: (image) => state.images.push(image),
    setToolTip: (text) => {
      state.tooltip = text;
    }
  };
  const flasher = {
    foreground: async () => (foreground ? "1" : "2"),
    flash: flash || (async () => {
      state.flashes.push(true);
      return "ok";
    }),
    stop: async () => {
      state.flashes.push(false);
    },
    setIcon: async (hwnd, iconPath) => {
      state.icons.push(iconPath);
      return "ok";
    }
  };
  const attention = createAttention({
    getWindow: () => window,
    getTray: () => tray,
    getIcons: () => ({ normal: "normal", blank: "blank", windowIcon }),
    flasher,
    schedule(fn, delay) {
      const id = state.intervals.size + 1;
      state.intervals.set(id, { id, fn, delay });
      return id;
    },
    cancel(id) {
      state.intervals.delete(id);
    }
  });
  return { state, attention };
}

test("new messages keep a hidden window hidden and slowly alternate complete tray icons", async () => {
  const { state, attention } = setup();
  await attention.attractAttention();
  assert.equal(state.visible, false);
  assert.equal(state.minimized, false);
  assert.equal(state.intervals.size, 1);
  assert.equal(state.images.at(-1), "blank");
  const timer = [...state.intervals.values()][0];
  assert.equal(timer.delay, 500);
  timer.fn();
  timer.fn();
  assert.deepEqual(state.images, ["blank", "normal", "blank"]);
  await attention.attractAttention();
  assert.equal(state.intervals.size, 1);
  attention.stopAttention();
  assert.equal(state.intervals.size, 0);
  assert.equal(state.images.at(-1), "normal");
  timer.fn();
  assert.equal(state.images.at(-1), "normal");
});

test("minimized windows stay minimized while the taskbar is notified", async () => {
  const { state, attention } = setup({ visible: false, minimized: true });
  await attention.attractAttention();
  assert.equal(state.visible, false);
  assert.equal(state.minimized, true);
  assert.ok(state.flashes.includes(true));
});

test("taskbar flashing continues until the user acknowledges the reminder", async () => {
  const { state, attention } = setup({ visible: true });
  await attention.attractAttention();
  assert.equal(state.flashes.at(-1), true);
  assert.equal(state.images.at(-1), "blank");
  attention.stopAttention();
  assert.equal(state.flashes.at(-1), false);
  assert.equal(state.images.at(-1), "normal");
});

test("messages in the foreground do not start background reminders", async () => {
  const { state, attention } = setup({ visible: true, foreground: true });
  await attention.attractAttention();
  assert.equal(state.images.length, 0);
  assert.equal(state.flashes.length, 0);
});

test("acknowledging while a foreground check is pending cancels the reminder", async () => {
  const { state, attention } = setup({ visible: true });
  const result = attention.attractAttention();
  attention.stopAttention();
  await result;
  assert.equal(state.images.at(-1), "normal");
  assert.ok(!state.flashes.includes(true));
});

test("a late flashing failure cannot restart an acknowledged reminder", async () => {
  let rejectFlash;
  const { state, attention } = setup({
    visible: true,
    flash: () => new Promise((_resolve, reject) => {
      rejectFlash = reject;
    })
  });
  const result = attention.attractAttention();
  await new Promise((resolve) => setImmediate(resolve));
  attention.stopAttention();
  rejectFlash(new Error("helper closed"));
  await result;
  assert.ok(!state.flashes.includes(true));
});

test("taskbar alternates the whole window icon until the reminder is acknowledged", async () => {
  const { state, attention } = setup({ visible: true, windowIcon: "C:/oa/window.ico" });
  await attention.attractAttention();
  assert.deepEqual(state.icons, ["0"]);
  const timers = [...state.intervals.values()].filter((item) => item.delay === 500);
  const taskbar = timers[timers.length - 1];
  taskbar.fn();
  taskbar.fn();
  assert.deepEqual(state.icons, ["0", "C:/oa/window.ico", "0"]);
  attention.stopAttention();
  assert.equal(state.icons.at(-1), "C:/oa/window.ico");
  taskbar.fn();
  assert.equal(state.icons.at(-1), "C:/oa/window.ico");
});
