const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function loadBridge(storage, target = new EventTarget()) {
  const window = {
    localStorage: storage,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target)
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/oa-bridge"), "utf8"), {
    window,
    require: () => ({ ipcRenderer: { send() {} } }),
    setInterval() {}
  });
  return window.emRequire("electron-store");
}

test("OA file-card storage is constructible and survives page reload", () => {
  const saved = new Map();
  const storage = { getItem: (key) => saved.get(key), setItem: (key, value) => saved.set(key, value) };
  const Store = loadBridge(storage);
  const files = new Store({ name: "file" });
  assert.equal(files.get("message-1"), undefined);
  files.set("message-1", "C:/Downloads/example.html");
  assert.equal(new Store({ name: "file" }).get("message-1"), "C:/Downloads/example.html");
  assert.equal(new Store({ name: "other" }).has("message-1"), false);
  const ReloadedStore = loadBridge(storage);
  const reloaded = new ReloadedStore({ name: "file" });
  assert.equal(reloaded.get("message-1"), "C:/Downloads/example.html");
  reloaded.delete("message-1");
  assert.equal(reloaded.has("message-1"), false);
});

test("focus listeners deduplicate and can be removed after wrapping", () => {
  const target = new EventTarget();
  const window = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target)
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/oa-bridge"), "utf8"), {
    window,
    require: () => ({ ipcRenderer: { sendSync: () => ({ focused: true }) } }),
    setInterval() {}
  });
  let calls = 0;
  const listener = () => { calls += 1; };
  window.addEventListener("focus", listener);
  window.addEventListener("focus", listener);
  target.dispatchEvent(new Event("focus"));
  assert.equal(calls, 1);
  window.removeEventListener("focus", listener);
  target.dispatchEvent(new Event("focus"));
  assert.equal(calls, 1);
  window.addEventListener("focus", listener);
  target.dispatchEvent(new Event("focus"));
  assert.equal(calls, 2);
});

test("file cards can initialize when local storage is unavailable or corrupt", () => {
  for (const storage of [
    { getItem: () => "invalid JSON", setItem() {} },
    { getItem() { throw new Error("unavailable"); }, setItem() { throw new Error("unavailable"); } }
  ]) {
    const Store = loadBridge(storage);
    const files = new Store({ name: "file" });
    files.set("message-1", "example.html");
    assert.equal(files.get("message-1"), "example.html");
  }
});

function loadBridgeEnv({ nativeNotification, domMessage, pathname = "/sp/em/main", writeClipboard } = {}) {
  const sent = [];
  const ipcListeners = new Map();
  const timers = new Map();
  let timerSeq = 0;
  const target = new EventTarget();
  const window = {
    location: { pathname, href: "https://oa.yarward.com" + pathname },
    Notification: nativeNotification,
    __extractOaDomMessage: domMessage ? () => domMessage : undefined,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target)
  };
  const messagePopup = require("../src/message-popup");
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/oa-bridge"), "utf8"), {
    window,
    Date,
    setInterval() {},
    setTimeout(fn, delay) {
      timerSeq += 1;
      timers.set(timerSeq, { fn, delay });
      return timerSeq;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    require(name) {
      if (name === "./message-popup") {
        return messagePopup;
      }
      return {
        ipcRenderer: {
          on(channel, fn) {
            if (!ipcListeners.has(channel)) ipcListeners.set(channel, []);
            ipcListeners.get(channel).push(fn);
          },
          send(channel, ...args) {
            const payload = args[0];
            sent.push({
              channel,
              args,
              payload: payload && typeof payload === "object" ? { ...payload } : payload
            });
          },
          sendSync(channel, value) {
            if (channel === "oa:clipboard-write-text") return writeClipboard(value);
            return { focused: false, visible: true, minimized: false };
          },
          invoke(channel, value) {
            if (channel === "oa:clipboard-write-text") return Promise.resolve(writeClipboard(value));
            return Promise.resolve(null);
          }
        }
      };
    }
  });
  return {
    window,
    sent,
    timers,
    emitHostIpc(channel, ...args) {
      for (const fn of ipcListeners.get(channel) || []) {
        fn({}, ...args);
      }
    }
  };
}

test("both desktop clipboard entry points wait for a successful full text write", async () => {
  const writes = [];
  const { window } = loadBridgeEnv({ writeClipboard(value) { writes.push(value); return writes.length === 1; } });
  const link = "https://example.test/docs/long-path?lang=中文&key=value#section";
  await window.emRequire("electron").clipboard.writeText(link);
  await assert.rejects(() => window.emRequire("@electron/remote").clipboard.writeText("下一条消息"), /剪贴板/);
  assert.deepEqual(writes, [link, "下一条消息"]);
});

test("Web Notification and ClientNotification forward sender and content via oa:message without native popups", async () => {
  let nativeConstructed = 0;
  function NativeNotification() {
    nativeConstructed += 1;
  }
  NativeNotification.permission = "default";
  NativeNotification.requestPermission = () => Promise.resolve("denied");

  const { window, sent } = loadBridgeEnv({ nativeNotification: NativeNotification });
  assert.equal(window.Notification.permission, "granted");
  let callbackPerm = "";
  assert.equal(await window.Notification.requestPermission((p) => { callbackPerm = p; }), "granted");
  assert.equal(callbackPerm, "granted");

  const webNotice = new window.Notification("张三", { body: "下午三点开会" });
  let webClicks = 0;
  webNotice.onclick = () => { webClicks += 1; };
  webNotice.addEventListener("click", () => { webClicks += 1; });

  assert.equal(nativeConstructed, 0);
  assert.deepEqual(sent.filter((e) => e.channel === "oa:message").map(({ channel, payload }) => ({ channel, payload })), [
    { channel: "oa:message", payload: { sender: "张三", content: "下午三点开会" } }
  ]);
  assert.ok(sent.some((e) => e.channel === "oa:attention"));
  assert.equal(window.__triggerOaNoticeClick({ sender: "张三" }), true);
  assert.equal(webClicks, 2);

  const electron = window.emRequire("electron");
  const remote = window.emRequire("@electron/remote");
  assert.equal(electron.Notification, remote.Notification);

  const clientNotice = new electron.Notification({ title: "新消息", body: "李四: 文件已发送" });
  let clientClicks = 0;
  clientNotice.on("click", () => { clientClicks += 1; });
  assert.deepEqual(
    sent.filter((e) => e.channel === "oa:message").map(({ channel, payload }) => ({ channel, payload })).at(-1),
    {
      channel: "oa:message",
      payload: { sender: "李四", content: "文件已发送" }
    }
  );
  assert.equal(window.__triggerOaNoticeClick({ sender: "李四" }), true);
  assert.equal(clientClicks, 1);
});

test("notification bridge forwards the group title alongside the member and preview", () => {
  const { window, sent } = loadBridgeEnv();
  const notice = new window.Notification("工作消息", {
    body: "谭启春：请看工作流",
    data: { groupName: "事项的新反馈" }
  });
  let clicks = 0;
  notice.onclick = () => { clicks += 1; };
  const payload = { sender: "谭启春", content: "请看工作流", conversation: "事项的新反馈" };
  assert.deepEqual(sent.find((event) => event.channel === "oa:message").payload, payload);
  assert.equal(window.__triggerOaNoticeClick({ ...payload, conversation: "其他会话" }), false);
  assert.equal(window.__triggerOaNoticeClick(payload), true);
  assert.equal(clicks, 1);
});

test("open-message-popup-window and tray-flash forward immediate payloads or fall back to DOM after delay", () => {
  const { window, sent, timers } = loadBridgeEnv({
    domMessage: { sender: "王五", content: "刚发了一张图片" }
  });
  const { ipcRenderer } = window.emRequire("electron");

  // Explicit payload emits oa:message immediately
  ipcRenderer.send("open-message-popup-window", { senderName: "赵六", content: "请看文档" });
  assert.deepEqual(sent.filter((e) => e.channel === "oa:message").map(({ channel, payload }) => ({ channel, payload })), [
    { channel: "oa:message", payload: { sender: "赵六", content: "请看文档" } }
  ]);

  // flashFrame: false never triggers oa:message
  sent.length = 0;
  ipcRenderer.send("tray-flash", { flashFrame: false });
  assert.equal(timers.size, 0);
  assert.equal(sent.filter((e) => e.channel === "oa:message").length, 0);

  // Without explicit message payload, waits 120ms and falls back to DOM or default text
  const fresh = loadBridgeEnv({ domMessage: { sender: "王五", content: "刚发了一张图片" } });
  fresh.window.emRequire("electron").ipcRenderer.send("tray-flash");
  assert.equal(fresh.timers.size, 1);
  const [entry] = [...fresh.timers.values()];
  assert.equal(entry.delay, 120);
  entry.fn();
  assert.deepEqual(fresh.sent.filter((e) => e.channel === "oa:message").map(({ channel, payload }) => ({ channel, payload })), [
    { channel: "oa:message", payload: { sender: "王五", content: "刚发了一张图片" } }
  ]);

  const noDom = loadBridgeEnv();
  noDom.window.emRequire("electron").ipcRenderer.send("tray-flash");
  [...noDom.timers.values()][0].fn();
  assert.deepEqual(noDom.sent.filter((e) => e.channel === "oa:message").map(({ channel, payload }) => ({ channel, payload })), [
    { channel: "oa:message", payload: { sender: "工作消息", content: "收到一条新消息，点击查看" } }
  ]);

  // Explicit notification cancels pending fallback timer
  const cancelCase = loadBridgeEnv({ domMessage: { sender: "王五", content: "兜底" } });
  cancelCase.window.emRequire("electron").ipcRenderer.send("open-message-popup-window");
  assert.equal(cancelCase.timers.size, 1);
  new cancelCase.window.Notification("陈七", { body: "准确消息" });
  assert.equal(cancelCase.timers.size, 0);
  assert.deepEqual(cancelCase.sent.filter((e) => e.channel === "oa:message").map(({ channel, payload }) => ({ channel, payload })), [
    { channel: "oa:message", payload: { sender: "陈七", content: "准确消息" } }
  ]);
});

test("photo-view IPC channels and window oliType are bridged cleanly", () => {
  const mainEnv = loadBridgeEnv({ pathname: "/sp/em/main" });
  const mainElectron = mainEnv.window.emRequire("electron");
  assert.equal(mainElectron.remote.getCurrentWindow().oliType, "main");

  mainElectron.ipcRenderer.send("init-photo-view");
  mainElectron.ipcRenderer.send("show-photo-view", { url: "https://oa.yarward.com/img.png" });
  assert.deepEqual(
    mainEnv.sent.filter((e) => e.channel === "oa:photo-ipc").map((e) => e.args),
    [
      ["show-photo-view", { url: "https://oa.yarward.com/img.png" }]
    ]
  );

  const photoEnv = loadBridgeEnv({ pathname: "/sp/em/photoview" });
  const photoElectron = photoEnv.window.emRequire("electron");
  assert.equal(photoElectron.remote.getCurrentWindow().oliType, "photo-view");

  const received = [];
  photoElectron.ipcRenderer.on("photo-view-params", (_event, args) => {
    received.push(args);
  });
  photoEnv.emitHostIpc("oa:bridge-ipc", "photo-view-params", { imageId: "123" });
  assert.deepEqual(received, [{ imageId: "123" }]);

  photoElectron.remote.getCurrentWindow().close();
  assert.deepEqual(
    photoEnv.sent.filter((e) => e.channel === "oa:photo-ipc").map((e) => e.args[0]),
    ["close-photo-view"]
  );
});

test("get-all-support-js-api immediately emits get-all-support-js-api.result to avoid 3s SDK ready wait", async () => {
  const { window } = loadBridgeEnv({ pathname: "/sp/em/main" });
  const ipc = window.emRequire("electron").ipcRenderer;
  const received = [];
  ipc.once("get-all-support-js-api.result", (_event, payload) => {
    received.push(payload);
  });
  ipc.send("get-all-support-js-api");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(received.length, 1);
  const apis = JSON.parse(received[0].res);
  assert.ok(apis.includes("independentPhotoView"));
});
