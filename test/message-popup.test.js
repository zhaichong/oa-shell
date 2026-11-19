const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeMessagePayload,
  extractDomSessionMessage,
  installDomMessageObserver,
  computePopupBounds,
  createPopupController,
  buildPopupHtml
} = require("../src/message-popup");

function createFakeTimers() {
  let nextId = 0;
  let clock = 1000;
  const timers = new Map();
  return {
    now: () => clock,
    advance(ms) {
      clock += ms;
      for (const [id, entry] of [...timers.entries()]) {
        if (entry.at <= clock) {
          timers.delete(id);
          entry.fn();
        }
      }
    },
    schedule(fn, delay) {
      nextId += 1;
      timers.set(nextId, { fn, at: clock + delay });
      return nextId;
    },
    cancel(id) {
      timers.delete(id);
    },
    pendingCount: () => timers.size
  };
}

function makeElement(tag, { id = "", classes = [], text = "", attrs = {}, hidden = false, style = {} } = {}) {
  const classSet = new Set(classes);
  const children = [];
  let ownText = text;
  const el = {
    tagName: tag.toUpperCase(),
    id,
    hidden,
    style: { ...style },
    dataset: {},
    parentNode: null,
    children,
    classList: {
      contains: (name) => classSet.has(name),
      add: (name) => classSet.add(name),
      remove: (name) => classSet.delete(name),
      toggle: (name, force) => {
        const shouldAdd = force === undefined ? !classSet.has(name) : Boolean(force);
        if (shouldAdd) classSet.add(name);
        else classSet.delete(name);
      }
    },
    get className() {
      return [...classSet].join(" ");
    },
    set className(value) {
      classSet.clear();
      String(value || "").split(/\s+/).filter(Boolean).forEach((c) => classSet.add(c));
    },
    get textContent() {
      if (children.length === 0) {
        return ownText;
      }
      return ownText + children.map((child) => child.textContent).join("");
    },
    set textContent(value) {
      ownText = String(value || "");
      children.length = 0;
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    appendChild(child) {
      child.parentNode = el;
      children.push(child);
      return child;
    },
    insertBefore(child, ref) {
      child.parentNode = el;
      const idx = ref ? children.indexOf(ref) : -1;
      if (idx === -1) children.push(child);
      else children.splice(idx, 0, child);
      return child;
    },
    remove() {
      if (el.parentNode) {
        const idx = el.parentNode.children.indexOf(el);
        if (idx !== -1) el.parentNode.children.splice(idx, 1);
        el.parentNode = null;
      }
    },
    matches(selectorGroup) {
      return selectorGroup.split(",").map((s) => s.trim()).filter(Boolean).some((selector) => {
        const parts = selector.split(/\s+/);
        if (parts.length > 1) {
          if (!matchesSimple(el, parts[parts.length - 1])) return false;
          let cur = el.parentNode;
          let idx = parts.length - 2;
          while (cur && idx >= 0) {
            if (matchesSimple(cur, parts[idx])) idx -= 1;
            cur = cur.parentNode;
          }
          return idx < 0;
        }
        return matchesSimple(el, parts[0]);
      });
    },
    closest(selectorGroup) {
      let cur = el;
      while (cur) {
        if (cur.matches(selectorGroup)) return cur;
        cur = cur.parentNode;
      }
      return null;
    },
    querySelectorAll(selectorGroup) {
      const found = [];
      function walk(node) {
        for (const child of node.children) {
          if (child.matches(selectorGroup)) found.push(child);
          walk(child);
        }
      }
      walk(el);
      return found;
    },
    querySelector(selectorGroup) {
      return el.querySelectorAll(selectorGroup)[0] || null;
    }
  };
  return el;
}

function matchesSimple(el, simple) {
  let rest = simple;
  if (rest.includes("[class*=\"unread\"]")) {
    if (!String(el.className || "").includes("unread")) return false;
    rest = rest.replace("[class*=\"unread\"]", "");
  }
  if (rest.includes("[class*=\"badge\"]")) {
    if (!String(el.className || "").includes("badge")) return false;
    rest = rest.replace("[class*=\"badge\"]", "");
  }
  if (rest.includes("[contenteditable='true']")) {
    if (el.getAttribute("contenteditable") !== "true") return false;
    rest = rest.replace("[contenteditable='true']", "");
  }
  if (rest.includes(":not(.im-hide)")) {
    if (el.classList.contains("im-hide")) return false;
    rest = rest.replace(":not(.im-hide)", "");
  }
  const tokens = rest.match(/([.#]?[a-zA-Z0-9_-]+)/g) || [];
  return tokens.every((token) => {
    if (token.startsWith("#")) return el.id === token.slice(1);
    if (token.startsWith(".")) return el.classList.contains(token.slice(1));
    return el.tagName.toLowerCase() === token.toLowerCase();
  });
}

function makeDoc(rootChildren = []) {
  const listeners = new Map();
  const body = makeElement("body");
  rootChildren.forEach((child) => body.appendChild(child));
  const observers = [];
  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.active = false;
      observers.push(this);
    }
    observe() {
      this.active = true;
    }
    disconnect() {
      this.active = false;
    }
  }
  return {
    body,
    documentElement: body,
    readyState: "complete",
    defaultView: { MutationObserver: MockMutationObserver },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type);
      if (!list) return;
      const idx = list.indexOf(fn);
      if (idx !== -1) list.splice(idx, 1);
    },
    dispatchEvent(event) {
      for (const fn of [...(listeners.get(event.type) || [])]) {
        fn(event);
      }
    },
    querySelector: (s) => body.querySelector(s),
    querySelectorAll: (s) => body.querySelectorAll(s),
    triggerMutations() {
      observers.filter((o) => o.active).forEach((o) => o.cb([]));
    }
  };
}

function makeSessionItem({ id, name, last, unreadBadge = "", unreadPrefix = "", active = false, isAssistant = false } = {}) {
  const classes = ["session-item"];
  if (active) classes.push("is-active");
  if (isAssistant) classes.push("oa-assistant-pin");
  const item = makeElement("div", {
    id: isAssistant ? "oa-shell-assistant" : "",
    classes,
    attrs: id ? { "data-id": id } : {}
  });
  const nameBox = makeElement("div", { classes: ["name"] });
  nameBox.appendChild(makeElement("span", { classes: ["span-text"], text: name }));
  item.appendChild(nameBox);

  const lastBox = makeElement("div", { classes: ["last"] });
  if (unreadPrefix) {
    lastBox.appendChild(makeElement("span", { classes: ["last-message-unread"], text: unreadPrefix }));
  }
  lastBox.appendChild(makeElement("span", { text: unreadPrefix ? " " + last : last }));
  item.appendChild(lastBox);

  if (unreadBadge) {
    item.appendChild(makeElement("span", { classes: ["ui-badge"], text: unreadBadge }));
  }
  return item;
}

function makeOliMessage({ id = "", text = "", me = false } = {}) {
  const msg = makeElement("div", {
    classes: me ? ["oli-message", "me"] : ["oli-message"],
    attrs: id ? { "data-id": id } : {}
  });
  msg.appendChild(makeElement("div", { classes: ["content", "is-text"], text }));
  return msg;
}

test("normalizeMessagePayload handles Notification, nested payloads, colon splitting, and prefixes", () => {
  assert.deepEqual(normalizeMessagePayload("张三", { body: "下午三点开会" }), {
    sender: "张三",
    content: "下午三点开会"
  });
  assert.deepEqual(normalizeMessagePayload({ title: "李四", body: "[3条] [图片]" }), {
    sender: "李四",
    content: "[图片]"
  });
  assert.deepEqual(normalizeMessagePayload("新消息", { body: "[2条] 王五: 文件发你了" }), {
    sender: "王五",
    content: "文件发你了"
  });
  assert.deepEqual(normalizeMessagePayload("OA", { body: "赵六：请在 OA 上确认" }), {
    sender: "赵六",
    content: "请在 OA 上确认"
  });
  assert.deepEqual(normalizeMessagePayload({ message: { senderName: "周七", text: "[2条未读] 收到" } }), {
    sender: "周七",
    content: "收到"
  });
  assert.deepEqual(normalizeMessagePayload([{ fromName: "钱八", lastMsg: "马上处理" }]), {
    sender: "钱八",
    content: "马上处理"
  });

  // Does not split times, URLs, or voice durations on colon
  assert.deepEqual(normalizeMessagePayload({ title: "工作消息", body: "14:30 在二楼会议室" }), {
    sender: "工作消息",
    content: "14:30 在二楼会议室"
  });
  assert.deepEqual(normalizeMessagePayload({ title: "工作消息", body: "https://oa.yarward.com/item" }), {
    sender: "工作消息",
    content: "https://oa.yarward.com/item"
  });
  assert.deepEqual(normalizeMessagePayload({ title: "工作消息", body: "[语音] 0:12" }), {
    sender: "工作消息",
    content: "[语音] 0:12"
  });

  // Empty / non-message payloads
  assert.equal(normalizeMessagePayload(null), null);
  assert.equal(normalizeMessagePayload({ flashFrame: true }), null);

  // Length clamping
  const longResult = normalizeMessagePayload({ sender: "张".repeat(60), content: "内".repeat(200) });
  assert.equal(longResult.sender.length, 40);
  assert.equal(longResult.content.length, 160);
});

test("extractDomSessionMessage prefers unread sessions, skips assistant pin, and handles active incoming messages", () => {
  const layout = makeElement("div", { classes: ["weapp-em-im-main-layout"] });
  const sessionList = makeElement("div", { classes: ["session"] });
  sessionList.appendChild(makeSessionItem({ name: "分身", last: "可以直接交代加班和提醒", unreadBadge: "1", isAssistant: true }));
  sessionList.appendChild(makeSessionItem({ id: "s1", name: "张三", last: "旧消息" }));
  sessionList.appendChild(makeSessionItem({ id: "s2", name: "李四", last: "下午提交周报", unreadPrefix: "[2条]", unreadBadge: "2" }));
  layout.appendChild(sessionList);
  const doc = makeDoc([layout]);

  assert.deepEqual(extractDomSessionMessage(doc), {
    sender: "李四",
    content: "下午提交周报",
    unread: true
  });

  // Outgoing receipt (.last-message-unread / [未读] / [已读]) must never be treated as incoming unread
  const outgoingReceiptLayout = makeElement("div", { classes: ["weapp-em-im-main-layout"] });
  const receiptSessions = makeElement("div", { classes: ["session"] });
  const receiptItem = makeElement("div", { classes: ["session-item"] });
  const receiptName = makeElement("div", { classes: ["name"] });
  receiptName.appendChild(makeElement("span", { classes: ["span-text"], text: "巩彬" }));
  const receiptLast = makeElement("div", { classes: ["last"] });
  receiptLast.appendChild(makeElement("span", { classes: ["last-message-unread"], text: "[未读]" }));
  receiptLast.appendChild(makeElement("span", { text: " 你妹啊" }));
  receiptItem.appendChild(receiptName);
  receiptItem.appendChild(receiptLast);
  receiptSessions.appendChild(receiptItem);
  outgoingReceiptLayout.appendChild(receiptSessions);
  assert.equal(extractDomSessionMessage(makeDoc([outgoingReceiptLayout])), null);

  // Active chat fallback when no unread badge exists
  const activeLayout = makeElement("div", { classes: ["weapp-em-im-main-layout"] });
  const activeSessions = makeElement("div", { classes: ["session"] });
  activeSessions.appendChild(makeSessionItem({ id: "s1", name: "赵六", last: "在吗", active: true }));
  const msgMain = makeElement("div", { classes: ["message-main"] });
  const titleBar = makeElement("div", { classes: ["title-bar"] });
  titleBar.appendChild(makeElement("div", { classes: ["name"], text: "赵六" }));
  msgMain.appendChild(titleBar);
  msgMain.appendChild(makeOliMessage({ id: "m1", text: "在吗" }));
  activeLayout.appendChild(activeSessions);
  activeLayout.appendChild(msgMain);
  const activeDoc = makeDoc([activeLayout]);

  assert.deepEqual(extractDomSessionMessage(activeDoc), {
    sender: "赵六",
    content: "在吗",
    unread: false
  });

  // Outgoing last message returns null
  msgMain.appendChild(makeOliMessage({ id: "m2", text: "我在", me: true }));
  assert.equal(extractDomSessionMessage(activeDoc), null);
});

test("installDomMessageObserver skips initial baseline, detects new incoming messages, and ignores self-sent echoes", () => {
  const layout = makeElement("div", { classes: ["weapp-em-im-main-layout"] });
  const sessionList = makeElement("div", { classes: ["session"] });
  const itemA = makeSessionItem({ id: "a", name: "张三", last: "早上好", active: true });
  const itemB = makeSessionItem({ id: "b", name: "李四", last: "旧未读消息", unreadBadge: "1" });
  sessionList.appendChild(itemA);
  sessionList.appendChild(itemB);

  const msgMain = makeElement("div", { classes: ["message-main"] });
  const titleBar = makeElement("div", { classes: ["title-bar"] });
  const titleName = makeElement("div", { classes: ["name"], text: "张三" });
  titleBar.appendChild(titleName);
  msgMain.appendChild(titleBar);
  msgMain.appendChild(makeOliMessage({ id: "m1", text: "早上好" }));

  const chatInput = makeElement("div", { classes: ["chat-input"] });
  const editor = makeElement("div", { classes: ["ql-editor"], attrs: { contenteditable: "true" }, text: "我发的消息" });
  chatInput.appendChild(editor);

  layout.appendChild(sessionList);
  layout.appendChild(msgMain);
  layout.appendChild(chatInput);

  const doc = makeDoc([layout]);
  const received = [];
  const observer = installDomMessageObserver(doc, (msg) => received.push(msg), { debounceMs: 0 });

  // Initial baseline must not trigger notifications
  assert.equal(received.length, 0);

  // Incoming message in active chat
  msgMain.appendChild(makeOliMessage({ id: "m2", text: "三点开会" }));
  doc.triggerMutations();
  assert.deepEqual(received, [{ sender: "张三", content: "三点开会" }]);

  // Outgoing message (.me) must not trigger
  msgMain.appendChild(makeOliMessage({ id: "m3", text: "好的收到", me: true }));
  doc.triggerMutations();
  assert.equal(received.length, 1);

  // User presses Enter in composer and session preview updates: must ignore self-sent echo
  doc.dispatchEvent({ type: "keydown", key: "Enter", target: editor });
  itemA.querySelector(".last").textContent = "我发的消息";
  itemA.appendChild(makeElement("span", { classes: ["ui-badge"], text: "1" }));
  doc.triggerMutations();
  assert.equal(received.length, 1);

  // New unread message from李四
  itemB.querySelector(".last").textContent = "[2条] 请看附件";
  doc.triggerMutations();
  assert.deepEqual(received, [
    { sender: "张三", content: "三点开会" },
    { sender: "李四", content: "请看附件" }
  ]);

  // Switching active chat must not trigger for historical messages in newly opened chat
  titleName.textContent = "王五";
  msgMain.appendChild(makeOliMessage({ id: "m4", text: "昨天发的文件" }));
  doc.triggerMutations();
  assert.equal(received.length, 2);

  observer.disconnect();
});

test("sending an unread message to colleague A then switching to colleague B never triggers a popup", () => {
  let clock = 5000;
  const layout = makeElement("div", { classes: ["weapp-em-im-main-layout"] });
  const sessionList = makeElement("div", { classes: ["session"] });
  const gongbinItem = makeSessionItem({ id: "gb", name: "巩彬", last: "在吗", active: true });
  const zhangsanItem = makeSessionItem({ id: "zs", name: "张三", last: "好的" });
  sessionList.appendChild(gongbinItem);
  sessionList.appendChild(zhangsanItem);

  const msgMain = makeElement("div", { classes: ["message-main"] });
  const titleBar = makeElement("div", { classes: ["title-bar"] });
  const titleName = makeElement("div", { classes: ["name"], text: "巩彬" });
  titleBar.appendChild(titleName);
  msgMain.appendChild(titleBar);
  const oldMsg = makeOliMessage({ id: "m1", text: "在吗" });
  msgMain.appendChild(oldMsg);

  layout.appendChild(sessionList);
  layout.appendChild(msgMain);

  const doc = makeDoc([layout]);
  const received = [];
  const observer = installDomMessageObserver(doc, (msg) => received.push(msg), {
    debounceMs: 0,
    now: () => clock
  });

  // User sends "你妹啊" to 巩彬 (message shows .me, session preview gets .last-message-unread [未读])
  msgMain.appendChild(makeOliMessage({ id: "m2", text: "你妹啊", me: true }));
  const gongbinLast = gongbinItem.querySelector(".last");
  gongbinLast.textContent = "";
  gongbinLast.appendChild(makeElement("span", { classes: ["last-message-unread"], text: "[未读]" }));
  gongbinLast.appendChild(makeElement("span", { text: " 你妹啊" }));
  doc.triggerMutations();
  assert.equal(received.length, 0);

  // User clicks 张三 to switch chats; 巩彬 loses .is-active and keeps [未读] receipt; 张三 messages load asynchronously
  clock += 2000;
  doc.dispatchEvent({ type: "click", target: zhangsanItem });
  gongbinItem.classList.remove("is-active");
  zhangsanItem.classList.add("is-active");
  titleName.textContent = "张三";
  // Step 1: old messages cleared before 张三 history renders
  for (const existing of [...msgMain.querySelectorAll(".oli-message")]) {
    existing.remove();
  }
  doc.triggerMutations();
  assert.equal(received.length, 0);

  // Step 2: 张三's historical incoming message loads asynchronously 150ms later
  clock += 150;
  msgMain.appendChild(makeOliMessage({ id: "m10", text: "昨天发你的表格" }));
  doc.triggerMutations();
  assert.equal(received.length, 0);

  // Step 3: 张三 sends a genuinely new message afterwards -> popup MUST fire
  clock += 500;
  msgMain.appendChild(makeOliMessage({ id: "m11", text: "刚刚更新了" }));
  doc.triggerMutations();
  assert.deepEqual(received, [{ sender: "张三", content: "刚刚更新了" }]);

  // Step 4: 巩彬 replies -> badge appears on 巩彬's session -> popup MUST fire
  gongbinLast.textContent = "收到，这就看";
  gongbinItem.appendChild(makeElement("span", { classes: ["ui-badge"], text: "1" }));
  doc.triggerMutations();
  assert.deepEqual(received, [
    { sender: "张三", content: "刚刚更新了" },
    { sender: "巩彬", content: "收到，这就看" }
  ]);

  observer.disconnect();
});

test("computePopupBounds positions popup at bottom-right of workArea", () => {
  assert.deepEqual(computePopupBounds({ x: 0, y: 0, width: 1920, height: 1040 }), {
    x: 1568,
    y: 908,
    width: 336,
    height: 116
  });
  assert.deepEqual(computePopupBounds({ x: 100, y: 40, width: 1200, height: 800 }), {
    x: 948,
    y: 708,
    width: 336,
    height: 116
  });
});

test("createPopupController manages auto-dismiss, timer reset, dedupe, and fallback replacement", () => {
  const timers = createFakeTimers();
  const events = [];
  const controller = createPopupController({
    showPopup: (msg) => events.push({ type: "show", ...msg }),
    hidePopup: () => events.push({ type: "hide" }),
    durationMs: 5000,
    dedupeMs: 1500,
    schedule: timers.schedule,
    cancel: timers.cancel,
    now: timers.now
  });

  // Show first message and auto-close after 5000ms
  assert.equal(controller.show({ sender: "张三", content: "下午开会" }), true);
  assert.equal(controller.isOpen(), true);
  assert.deepEqual(controller.current(), { sender: "张三", content: "下午开会" });

  // Deduplicate identical message within 1500ms
  timers.advance(500);
  assert.equal(controller.show({ sender: "张三", content: "下午开会" }), false);

  // New message resets the 5s auto-close timer
  timers.advance(3000);
  assert.equal(controller.isOpen(), true);
  assert.equal(controller.show({ sender: "李四", content: "收到文件" }), true);
  timers.advance(4000);
  assert.equal(controller.isOpen(), true);
  timers.advance(1000);
  assert.equal(controller.isOpen(), false);
  assert.equal(controller.current(), null);

  // Fallback message can be upgraded immediately by a specific message, and late fallback cannot overwrite specific
  assert.equal(controller.show({ sender: "工作消息", content: "收到一条新消息，点击查看" }), true);
  timers.advance(100);
  assert.equal(controller.show({ sender: "王五", content: "审批已通过" }), true);
  timers.advance(100);
  assert.equal(controller.show({ sender: "工作消息", content: "收到一条新消息，点击查看" }), false);
  assert.deepEqual(controller.current(), { sender: "王五", content: "审批已通过" });

  // Manual dismiss clears timer and hides popup
  assert.equal(controller.dismiss(), true);
  assert.equal(controller.isOpen(), false);
  assert.equal(timers.pendingCount(), 0);
  assert.deepEqual(events.map((e) => e.type), ["show", "show", "hide", "show", "show", "hide"]);
});

test("buildPopupHtml renders compliant Flex layout and navigation actions", () => {
  const html = buildPopupHtml();
  assert.ok(html.includes('id="popupSender"'));
  assert.ok(html.includes('id="popupContent"'));
  assert.ok(html.includes('id="popupClose"'));
  assert.ok(html.includes("window.__renderPopup"));
  assert.ok(html.includes("https://oa-popup.local/open"));
  assert.ok(html.includes("https://oa-popup.local/close"));
  assert.equal(/display\s*:\s*grid/i.test(html), false);
  assert.equal(/(?:^|[;\s{])gap\s*:/i.test(html), false);
});
