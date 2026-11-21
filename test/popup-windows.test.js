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

function fakePopup() {
  const handlers = {};
  return {
    closed: false,
    isDestroyed: () => false,
    isMinimized: () => false,
    show() {},
    focus() {},
    close() { this.closed = true; },
    once(event, listener) { handlers[event] = listener; },
    webContents: {
      on(event, listener) { handlers[event] = listener; }
    },
    emit(event, ...args) { handlers[event]?.(...args); }
  };
}

test("a popup that navigates is found under its new URL, not the old one", () => {
  const registry = createPopupRegistry();
  const oldUrl = "https://oa.yarward.com/image-preview";
  const newUrl = "https://oa.yarward.com/photo-view";
  const popup = fakePopup();
  registry.register(oldUrl, popup);
  popup.emit("did-navigate", {}, newUrl);
  // A request for the new URL focuses the existing window instead of
  // opening a second copy; the old URL is free again.
  let focused = 0;
  popup.focus = () => { focused += 1; };
  assert.equal(registry.request(newUrl), false);
  assert.equal(focused, 1);
  assert.equal(registry.request(oldUrl), true);
});

test("a second registration for the same URL closes the orphaned window", () => {
  const registry = createPopupRegistry();
  const url = "https://oa.yarward.com/image-preview";
  const first = fakePopup();
  const second = fakePopup();
  registry.register(url, first);
  registry.register(url, second);
  assert.equal(first.closed, true);
  assert.equal(second.closed, false);
  // Closing the surviving window frees the URL.
  second.emit("closed");
  assert.equal(registry.request(url), true);
});

test("a popup navigating onto another popup's URL does not steal its registration", () => {
  const registry = createPopupRegistry();
  const urlA = "https://oa.yarward.com/a";
  const urlB = "https://oa.yarward.com/b";
  const popupA = fakePopup();
  const popupB = fakePopup();
  registry.register(urlA, popupA);
  registry.register(urlB, popupB);
  popupA.emit("did-navigate", {}, urlB);
  let focusedB = 0;
  popupB.focus = () => { focusedB += 1; };
  assert.equal(registry.request(urlB), false);
  assert.equal(focusedB, 1);
  let focusedA = 0;
  popupA.focus = () => { focusedA += 1; };
  assert.equal(registry.request(urlA), false);
  assert.equal(focusedA, 1);
});
