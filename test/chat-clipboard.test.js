const test = require("node:test");
const assert = require("node:assert/strict");
const { emojiText } = require("../src/chat-clipboard");

test("emoji alt labels copy as emoji instead of disappearing", () => {
  assert.equal(emojiText("[含泪的笑脸]"), "🥲");
  assert.equal(emojiText("[微笑]"), "[微笑]");
  assert.equal(emojiText("🥲"), "🥲");
  assert.equal(emojiText(""), "[表情]");
  assert.equal(emojiText(null), "[表情]");
});

const { installChatClipboard } = require("../src/chat-clipboard");

function makeNode({ classes = [], text = "", attrs = {}, children = [] } = {}) {
  const classSet = new Set(classes);
  const node = {
    classList: { contains: (name) => classSet.has(name) },
    get className() { return [...classSet].join(" "); },
    textContent: text,
    parentElement: null,
    children,
    isConnected: true,
    ownerDocument: { body: null },
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    cloneNode: () => makeNode({ classes: [...classSet], text, attrs: { ...attrs } }),
    contains(other) {
      if (!other) return false;
      let cur = other;
      while (cur) {
        if (cur === node) return true;
        cur = cur.parentElement;
      }
      return false;
    },
    closest(selector) {
      let cur = node;
      while (cur) {
        for (const part of selector.split(",").map((s) => s.trim())) {
          const tokens = part.split(".").filter(Boolean);
          if (tokens.length && tokens.every((t) => cur.classList.contains(t))) return cur;
        }
        cur = cur.parentElement;
      }
      return null;
    }
  };
  children.forEach((c) => { c.parentElement = node; });
  return node;
}

function setupClipboard() {
  const handlers = new Map();
  const written = [];
  const notice = { setAttribute() {}, classList: { toggle() {} }, textContent: "", remove() {} };
  const win = {
    document: {
      getElementById: () => null,
      createElement: () => notice,
      body: { append() {}, dispatchEvent() {} },
      activeElement: null
    },
    getSelection: () => null,
    setTimeout: () => 0,
    clearTimeout: () => {},
    MouseEvent: class { constructor() {} },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    }
  };
  const bridge = {
    writeText: async (text) => { written.push(text); return true; },
    writeImage: async () => false,
    copyImageAt: async () => false
  };
  installChatClipboard(win, bridge);
  return {
    win,
    written,
    fire(type, event) {
      for (const fn of handlers.get(type) || []) fn(event);
    }
  };
}

test("a copy button inside another message is not hijacked by the right-clicked message", async () => {
  const { written, fire } = setupClipboard();
  const bodyA = makeNode({ classes: ["content", "is-text"], text: "你好" });
  const messageA = makeNode({ classes: ["oli-message"], children: [bodyA] });
  const copyBtn = makeNode({ classes: ["copy-btn"], attrs: { "aria-label": "复制" } });
  const toolbar = makeNode({ classes: ["toolbar"], children: [copyBtn] });
  const messageB = makeNode({ classes: ["oli-message"], children: [toolbar] });

  fire("contextmenu", { target: bodyA });
  let prevented = 0;
  fire("click", {
    target: copyBtn,
    preventDefault: () => { prevented += 1; },
    stopImmediatePropagation: () => {}
  });
  assert.equal(prevented, 0);
  assert.deepEqual(written, []);

  // The same button in the body-level right-click menu still copies the right-clicked message.
  const menuBtn = makeNode({ classes: ["menu-item"], attrs: { "aria-label": "复制" } });
  const menu = makeNode({ classes: ["menu"], children: [menuBtn] });
  fire("contextmenu", { target: bodyA });
  fire("click", {
    target: menuBtn,
    preventDefault: () => { prevented += 1; },
    stopImmediatePropagation: () => {}
  });
  assert.equal(prevented, 1);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(written, ["你好"]);
});
