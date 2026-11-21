const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeMessagePayload,
  isHiddenNode,
  resolveActiveChatName,
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
  assert.deepEqual(normalizeMessagePayload("亚华 OA", { body: "赵六：请在 OA 上确认" }), {
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

test("normalizes serialized OA emoji before truncating the preview", () => {
  const emoji = '<img class="oli-emoji-item-img" style="width:16px; height:16px;" alt="[含泪的笑脸]" src="https://example.test/emoji.png">';
  assert.deepEqual(normalizeMessagePayload("张艺晗", { body: emoji }), {
    sender: "张艺晗",
    content: "🥲"
  });
  assert.deepEqual(normalizeMessagePayload({
    groupName: "项目群",
    content: "张艺晗：收到 " + emoji + " " + "<img alt='[自定义表情]' class='oli-emoji-item-img' src='emoji.png'>"
  }), {
    conversation: "项目群",
    sender: "张艺晗",
    content: "收到 🥲 [自定义表情]"
  });
  assert.equal(normalizeMessagePayload({ sender: "张艺晗", content: '<img src="file.png">' }).content, "[图片]");
});

test("group notifications keep their conversation when enriched or deduplicated", () => {
  const group = { conversation: "事项的新反馈", sender: "谭启春", content: "流程有新反馈" };
  assert.deepEqual(normalizeMessagePayload({ groupName: group.conversation, body: "谭启春：流程有新反馈" }), group);
  const layout = makeElement("div", { classes: ["weapp-em-im-main-layout"] });
  const sessions = makeElement("div", { classes: ["session"] });
  sessions.appendChild(makeSessionItem({ id: "group", name: group.conversation, last: "谭启春：流程有新反馈", unreadBadge: "1" }));
  layout.appendChild(sessions);
  const doc = makeDoc([layout]);
  const direct = { sender: group.sender, content: group.content };
  assert.deepEqual(extractDomSessionMessage(doc, direct), { ...group, unread: true });
  assert.equal(extractDomSessionMessage(doc, { ...direct, content: "另一条消息" }), null);
  assert.deepEqual(extractDomSessionMessage(doc), { ...group, unread: true });
  sessions.appendChild(makeSessionItem({ id: "other", name: "另一个群", last: "谭启春：流程有新反馈", unreadBadge: "1" }));
  // An ambiguous match falls back to the first session instead of no popup at all.
  assert.deepEqual(extractDomSessionMessage(doc, direct), { ...group, unread: true });

  const timers = createFakeTimers();
  const controller = createPopupController({
    showPopup() {},
    hidePopup() {},
    schedule: timers.schedule,
    cancel: timers.cancel
  });
  assert.equal(controller.show(group), true);
  assert.equal(controller.show(direct), false);
  assert.deepEqual(controller.current(), group);
  assert.equal(controller.show({ ...group, conversation: "另一个群" }), true);
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

test("a new unread session arriving while scrolling is deferred, not swallowed", () => {
  let clock = 5000;
  const layout = makeElement("div", { classes: ["weapp-em-im-main-layout"] });
  const sessionList = makeElement("div", { classes: ["session"] });
  const itemA = makeSessionItem({ id: "a", name: "张三", last: "早上好", active: true });
  sessionList.appendChild(itemA);

  const msgMain = makeElement("div", { classes: ["message-main"] });
  const titleBar = makeElement("div", { classes: ["title-bar"] });
  const titleName = makeElement("div", { classes: ["name"], text: "张三" });
  titleBar.appendChild(titleName);
  msgMain.appendChild(titleBar);
  msgMain.appendChild(makeOliMessage({ id: "m1", text: "早上好" }));

  layout.appendChild(sessionList);
  layout.appendChild(msgMain);

  const doc = makeDoc([layout]);
  const received = [];
  const observer = installDomMessageObserver(doc, (msg) => received.push(msg), {
    debounceMs: 0,
    now: () => clock
  });
  doc.triggerMutations();
  assert.equal(received.length, 0);

  // A brand-new unread session appears while the user is scrolling the
  // session list: nothing fires during the scroll window...
  doc.dispatchEvent({ type: "scroll", target: sessionList });
  const itemB = makeSessionItem({ id: "b", name: "李四", last: "请看附件", unreadBadge: "1" });
  sessionList.appendChild(itemB);
  doc.triggerMutations();
  assert.equal(received.length, 0);

  // ...but once the scrolling stops, the deferred message is emitted.
  clock += 1000;
  doc.triggerMutations();
  assert.deepEqual(received, [{ sender: "李四", content: "请看附件" }]);

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

test("switching sessions without a click never pops up for late-loading history", () => {
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
  msgMain.appendChild(makeOliMessage({ id: "m1", text: "在吗" }));

  layout.appendChild(sessionList);
  layout.appendChild(msgMain);

  const doc = makeDoc([layout]);
  const received = [];
  const observer = installDomMessageObserver(doc, (msg) => received.push(msg), {
    debounceMs: 0,
    now: () => clock
  });
  doc.triggerMutations();
  assert.equal(received.length, 0);

  // Programmatic / keyboard switch to 张三 (no click event at all):
  // the old messages are still in the DOM when the switch is observed.
  clock += 2000;
  gongbinItem.classList.remove("is-active");
  zhangsanItem.classList.add("is-active");
  titleName.textContent = "张三";
  doc.triggerMutations();
  assert.equal(received.length, 0);

  // 张三's history loads late (after the 1200ms switch window): it is
  // history, not a new message, so no popup may fire.
  clock += 2000;
  for (const existing of [...msgMain.querySelectorAll(".oli-message")]) {
    existing.remove();
  }
  msgMain.appendChild(makeOliMessage({ id: "m10", text: "昨天发你的表格" }));
  doc.triggerMutations();
  assert.equal(received.length, 0);

  // A genuinely new message in 张三 afterwards still pops up.
  clock += 500;
  msgMain.appendChild(makeOliMessage({ id: "m11", text: "刚刚更新了" }));
  doc.triggerMutations();
  assert.deepEqual(received, [{ sender: "张三", content: "刚刚更新了" }]);

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
  // Even after the 1500ms dedupe window, a fallback still cannot
  // overwrite the specific message on screen.
  timers.advance(2000);
  assert.equal(controller.isOpen(), true);
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

test("extractDomSessionMessage returns unread sessions with an empty preview", () => {
  const layout = makeElement("div", { classes: ["weapp-em-im-main-layout"] });
  const sessionList = makeElement("div", { classes: ["session"] });
  sessionList.appendChild(makeSessionItem({ id: "s1", name: "张三", last: "", unreadBadge: "1" }));
  layout.appendChild(sessionList);
  const doc = makeDoc([layout]);
  assert.deepEqual(extractDomSessionMessage(doc), {
    sender: "张三",
    content: "",
    unread: true
  });
});

test("two sessions with the same name are tracked separately", () => {
  const layout = makeElement("div", { classes: ["weapp-em-im-main-layout"] });
  const sessionList = makeElement("div", { classes: ["session"] });
  const itemA = makeSessionItem({ name: "张三", last: "旧消息一" });
  const itemB = makeSessionItem({ name: "张三", last: "旧消息二", unreadBadge: "1" });
  sessionList.appendChild(itemA);
  sessionList.appendChild(itemB);
  const msgMain = makeElement("div", { classes: ["message-main"] });
  const titleBar = makeElement("div", { classes: ["title-bar"] });
  titleBar.appendChild(makeElement("div", { classes: ["name"], text: "张三" }));
  msgMain.appendChild(titleBar);
  layout.appendChild(sessionList);
  layout.appendChild(msgMain);
  const doc = makeDoc([layout]);
  const received = [];
  installDomMessageObserver(doc, (msg) => received.push(msg), { debounceMs: 0 });
  assert.equal(received.length, 0);
  // A third same-named session arrives unread with the same preview
  // text the second one already had: without separate records it
  // would be mistaken for the known session and never pop up.
  const itemC = makeSessionItem({ name: "张三", last: "旧消息二", unreadBadge: "1" });
  sessionList.appendChild(itemC);
  doc.triggerMutations();
  assert.deepEqual(received, [{ sender: "张三", content: "旧消息二" }]);
});

test("truncation never splits an emoji in half", () => {
  const content = "a".repeat(159) + "🥲";
  const normalized = normalizeMessagePayload({ sender: "张三", content });
  assert.equal(normalized.content, content);
  assert.ok(normalized.content.endsWith("🥲"));
});

test("isHiddenNode sees class-based hiding through computed style", () => {
  const hiddenByClass = {
    hidden: false,
    style: {},
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "none" }) } }
  };
  assert.equal(isHiddenNode(hiddenByClass), true);
  const visible = {
    hidden: false,
    style: {},
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: "block" }) } }
  };
  assert.equal(isHiddenNode(visible), false);
  assert.equal(isHiddenNode({ hidden: true, style: {} }), true);
  assert.equal(isHiddenNode({ hidden: false, style: { display: "none" } }), true);
});

test("resolveActiveChatName uses the title, falling back to the active session when the title is empty", () => {
  const root = makeElement("div");
  const titleBar = makeElement("div", { classes: ["title-bar"] });
  const titleName = makeElement("div", { classes: ["name"], text: "李四" });
  titleBar.appendChild(titleName);
  root.appendChild(titleBar);
  // Title present: it is the earliest switch signal, so it wins even
  // when the session list still marks the old chat active.
  assert.equal(resolveActiveChatName(root, [{ sender: "张三", active: true }]), "李四");
  // Title empty (still loading): fall back to the active session.
  titleName.textContent = "";
  assert.equal(resolveActiveChatName(root, [{ sender: "张三", active: true }]), "张三");
  assert.equal(resolveActiveChatName(root, [{ sender: "张三", active: false }]), "");
});

test("createPopupController recovers when showing the popup throws", () => {
  const timers = createFakeTimers();
  const controller = createPopupController({
    showPopup() { throw new Error("render failed"); },
    hidePopup() {},
    schedule: timers.schedule,
    cancel: timers.cancel,
    now: timers.now
  });
  assert.equal(controller.show({ sender: "张三", content: "下午开会" }), false);
  assert.equal(controller.isOpen(), false);
  assert.deepEqual(controller.current(), null);
});
