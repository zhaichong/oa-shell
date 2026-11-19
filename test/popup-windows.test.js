const test = require("node:test");
const assert = require("node:assert/strict");
const { createPopupRegistry } = require("../src/popup-windows");

test("repeated preview requests reuse a window and allow reopening after close", () => {
  const registry = createPopupRegistry();
  const url = "https://oa.yarward.com/image-preview";
  assert.equal(registry.request(url), true);
  assert.equal(registry.request(url), false);
  let closed;
  let focused = 0;
  registry.register(url, {
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() { focused += 1; },
    once(event, listener) { closed = listener; }
  });
  assert.equal(registry.request(url), false);
  assert.equal(focused, 1);
  assert.equal(registry.request(url + "-other"), true);
  closed();
  assert.equal(registry.request(url), true);
});
