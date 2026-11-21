const test = require("node:test");
const assert = require("node:assert/strict");
const { createPreviewFeedback } = require("../src/image-preview");

function setup() {
  const timers = new Map();
  const shown = [];
  let timerId = 0;
  const feedback = createPreviewFeedback({
    show: (text, busy) => shown.push({ text, busy }),
    hide() {},
    schedule(callback, delay) {
      timerId += 1;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    cancel: (timer) => timers.delete(timer)
  });
  return { feedback, shown, timers };
}

test("a single click opens once, provides immediate feedback, and blocks repeated clicks", () => {
  const { feedback, shown, timers } = setup();
  assert.equal(feedback.click(1), true);
  assert.deepEqual(shown.at(-1), { text: "正在打开图片…", busy: true });
  assert.equal(feedback.click(1), false);
  assert.equal(feedback.click(2), false);
  assert.equal(timers.size, 1);
  feedback.finish();
  assert.equal(timers.size, 0);
  // Habitual second click of a double-click right after quick finish is still ignored
  assert.equal(feedback.click(2), false);
  // A fresh single click opens again
  assert.equal(feedback.click(1), true);
});

test("keyboard clicks work and slow loading releases the pending state", () => {
  const { feedback, shown, timers } = setup();
  assert.equal(feedback.click(0), true);
  const timeout = Array.from(timers.values()).find((timer) => timer.delay === 10000);
  timeout.callback();
  assert.deepEqual(shown.at(-1), { text: "图片打开较慢，请稍后重试", busy: false });
  assert.equal(feedback.click(1), true);
});

test("the slow message stays dismissible when the viewer opens late", () => {
  const { feedback, shown, timers } = setup();
  assert.equal(feedback.click(1), true);
  const timeout = Array.from(timers.values()).find((timer) => timer.delay === 10000);
  timeout.callback();
  assert.deepEqual(shown.at(-1), { text: "图片打开较慢，请稍后重试", busy: false });
  assert.equal(feedback.isLoading(), true);
  feedback.finish();
  assert.equal(feedback.isLoading(), false);
});
