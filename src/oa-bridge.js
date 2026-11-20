const { ipcRenderer } = require("electron");
const messagePopup = typeof require === "function" ? require("./message-popup") : null;
const normalizePayload = messagePopup && typeof messagePopup.normalizeMessagePayload === "function"
  ? messagePopup.normalizeMessagePayload
  : function (input, extra) {
      if (typeof input === "string") {
        const body = extra && typeof extra === "object" ? (extra.body || extra.content || "") : (typeof extra === "string" ? extra : "");
        return input || body ? { sender: input, content: String(body || "") } : null;
      }
      if (input && typeof input === "object") {
        const sender = String(input.sender || input.title || "");
        const content = String(input.content || input.body || "");
        return sender || content ? { sender, content } : null;
      }
      return null;
    };
const isGenericSender = messagePopup && typeof messagePopup.isGenericSender === "function"
  ? messagePopup.isGenericSender
  : function () { return false; };

const FALLBACK_DELAY_MS = 120;
const DEFAULT_SENDER = "工作消息";
const DEFAULT_CONTENT = "收到一条新消息";
const FLASH_FALLBACK_CONTENT = "收到一条新消息，点击查看";

let latestNotice = null;
let lastExplicitMessageAt = 0;
let fallbackTimer = null;

function noop() {}

const clientStores = new Map();

function ClientStore(options) {
  const name = String((options || {}).name || "config");
  const storageKey = "oa-shell:client-store:" + name;
  if (!clientStores.has(name)) {
    let values = Object.create(null);
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) || "{}");
      if (saved && typeof saved === "object" && !Array.isArray(saved)) {
        Object.assign(values, saved);
      }
    } catch (error) {
      noop(error);
    }
    clientStores.set(name, values);
  }
  const values = clientStores.get(name);
  function persist() {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(values));
    } catch (error) {
      noop(error);
    }
  }
  this.get = function (key, fallback) {
    return Object.prototype.hasOwnProperty.call(values, key) ? values[key] : fallback;
  };
  this.set = function (key, value) {
    values[key] = value;
    persist();
  };
  this.has = function (key) {
    return Object.prototype.hasOwnProperty.call(values, key);
  };
  this.delete = function (key) {
    delete values[key];
    persist();
  };
}

function signalAttention() {
  try {
    ipcRenderer.send("oa:attention");
  } catch (error) {
    noop(error);
  }
}

function extractDomMessage(candidate) {
  try {
    return typeof window.__extractOaDomMessage === "function" ? window.__extractOaDomMessage(candidate) : null;
  } catch (error) {
    return null;
  }
}

function noteExplicitMessageSent() {
  lastExplicitMessageAt = Date.now();
  if (fallbackTimer !== null && typeof clearTimeout === "function") {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
}

function sendMessagePopup(payload) {
  if (!payload || (!payload.sender && !payload.content)) {
    return;
  }
  noteExplicitMessageSent();
  try {
    ipcRenderer.send("oa:message", {
      sender: String(payload.sender || DEFAULT_SENDER),
      content: String(payload.content || DEFAULT_CONTENT),
      ...(payload.conversation ? { conversation: payload.conversation } : {})
    });
  } catch (error) {
    noop(error);
  }
}

function resolveNotificationPayload(input, extra) {
  const normalized = normalizePayload(input, extra);
  const matched = normalized && !normalized.conversation && normalized.content ? extractDomMessage(normalized) : null;
  if (matched?.conversation) return matched;
  const dom = (!normalized || !normalized.sender || isGenericSender(normalized.sender) || !normalized.content)
    ? extractDomMessage()
    : null;
  let sender = normalized ? normalized.sender : "";
  let content = normalized ? normalized.content : "";
  if (dom) {
    if ((!sender || isGenericSender(sender)) && dom.sender && (!content || content === dom.content)) {
      sender = dom.sender;
    }
    if (!content && dom.content) {
      content = dom.content;
    }
  }
  return {
    sender: sender || DEFAULT_SENDER,
    content: content || DEFAULT_CONTENT,
    ...((normalized?.conversation || (!normalized?.content && dom?.conversation))
      ? { conversation: normalized?.conversation || dom?.conversation } : {})
  };
}

function scheduleFlashMessage(payload) {
  const normalized = normalizePayload(payload);
  if (normalized && normalized.sender && normalized.content && !isGenericSender(normalized.sender)) {
    sendMessagePopup(resolveNotificationPayload(payload));
    return;
  }
  const scheduledAt = Date.now();
  if (scheduledAt - lastExplicitMessageAt < 250) {
    return;
  }
  const runFallback = function () {
    fallbackTimer = null;
    if (lastExplicitMessageAt >= scheduledAt) {
      return;
    }
    const snapshot = extractDomMessage();
    const dom = snapshot?.unread === false ? null : snapshot;
    const sender = (dom && dom.sender) || (normalized && normalized.sender) || DEFAULT_SENDER;
    const content = (dom && dom.content) || (normalized && normalized.content) || FLASH_FALLBACK_CONTENT;
    sendMessagePopup({ sender, content, conversation: dom?.conversation || normalized?.conversation });
  };
  if (typeof setTimeout === "function") {
    if (fallbackTimer !== null && typeof clearTimeout === "function") {
      clearTimeout(fallbackTimer);
    }
    fallbackTimer = setTimeout(runFallback, FALLBACK_DELAY_MS);
  } else {
    runFallback();
  }
}

function rememberNotice(resolved, hasListeners, triggerClick) {
  latestNotice = {
    sender: resolved.sender,
    content: resolved.content,
    conversation: resolved.conversation,
    hasListeners: hasListeners,
    triggerClick: triggerClick
  };
}

function installAttentionHook(NativeNotification) {
  if (NativeNotification && NativeNotification.__oaShell) {
    return NativeNotification;
  }
  function ShellNotification(title, options) {
    const opts = options && typeof options === "object" ? options : {};
    this.title = title === undefined || title === null ? "" : String(title);
    this.body = opts.body === undefined || opts.body === null ? "" : String(opts.body);
    this.tag = opts.tag || "";
    this.icon = opts.icon || "";
    this.data = opts.data;
    this.silent = Boolean(opts.silent);
    this.onclick = null;
    this.onshow = null;
    this.onclose = null;
    this.onerror = null;
    this._listeners = { click: [], show: [], close: [], error: [] };

    const self = this;
    const resolved = resolveNotificationPayload(this.title, opts);
    signalAttention();
    sendMessagePopup(resolved);
    rememberNotice(
      resolved,
      function () {
        return typeof self.onclick === "function" || self._listeners.click.length > 0;
      },
      function () {
        const event = { type: "click", target: self, currentTarget: self, preventDefault: noop, stopPropagation: noop };
        if (typeof self.onclick === "function") {
          try {
            self.onclick.call(self, event);
          } catch (error) {
            noop(error);
          }
        }
        self._listeners.click.slice().forEach(function (listener) {
          try {
            listener.call(self, event);
          } catch (error) {
            noop(error);
          }
        });
      }
    );
  }
  ShellNotification.prototype.addEventListener = function (type, listener) {
    if (typeof listener !== "function") {
      return;
    }
    if (!this._listeners[type]) {
      this._listeners[type] = [];
    }
    if (this._listeners[type].indexOf(listener) === -1) {
      this._listeners[type].push(listener);
    }
  };
  ShellNotification.prototype.removeEventListener = function (type, listener) {
    const list = this._listeners[type];
    if (!list) {
      return;
    }
    const index = list.indexOf(listener);
    if (index !== -1) {
      list.splice(index, 1);
    }
  };
  ShellNotification.prototype.dispatchEvent = function (event) {
    if (!event || !event.type) {
      return true;
    }
    const list = this._listeners[event.type];
    if (list) {
      list.slice().forEach((listener) => listener.call(this, event));
    }
    return true;
  };
  ShellNotification.prototype.close = function () {
    if (typeof this.onclose === "function") {
      try {
        this.onclose.call(this, { type: "close", target: this });
      } catch (error) {
        noop(error);
      }
    }
  };
  ShellNotification.__oaShell = true;
  Object.defineProperty(ShellNotification, "permission", {
    configurable: true,
    get: function () {
      return "granted";
    }
  });
  ShellNotification.requestPermission = function (callback) {
    if (typeof callback === "function") {
      try {
        callback("granted");
      } catch (error) {
        noop(error);
      }
    }
    return Promise.resolve("granted");
  };
  window.Notification = ShellNotification;
  return ShellNotification;
}

function createClientNotification() {
  function ClientNotification(options) {
    const payload = options || {};
    this.title = payload.title || "";
    this.body = payload.body || "";
    this._click = [];
    const self = this;
    const resolved = resolveNotificationPayload(payload);
    signalAttention();
    sendMessagePopup(resolved);
    rememberNotice(
      resolved,
      function () {
        return self._click.length > 0;
      },
      function () {
        self._click.slice().forEach(function (listener) {
          try {
            listener();
          } catch (error) {
            noop(error);
          }
        });
      }
    );
  }
  ClientNotification.prototype.on = function (event, listener) {
    if (event === "click" && typeof listener === "function" && this._click.indexOf(listener) === -1) {
      this._click.push(listener);
    }
    return this;
  };
  ClientNotification.prototype.once = ClientNotification.prototype.on;
  ClientNotification.prototype.removeListener = function (event, listener) {
    if (event === "click") {
      const index = this._click.indexOf(listener);
      if (index !== -1) {
        this._click.splice(index, 1);
      }
    }
    return this;
  };
  ClientNotification.prototype.removeAllListeners = function () {
    this._click = [];
    return this;
  };
  ClientNotification.prototype.show = function () {
    return this;
  };
  ClientNotification.prototype.close = function () {
    return;
  };
  ClientNotification.isSupported = function () {
    return true;
  };
  ClientNotification.permission = "granted";
  ClientNotification.requestPermission = function () {
    return Promise.resolve("granted");
  };
  return ClientNotification;
}

function installClientBridge() {
  const NativeNotification = window.Notification;
  installAttentionHook(NativeNotification);
  const ClientNotification = createClientNotification();
  window.__noteOaMessageSent = noteExplicitMessageSent;
  window.__triggerOaNoticeClick = function (payload) {
    if (!latestNotice || !latestNotice.hasListeners()) {
      return false;
    }
    const targetSender = payload && typeof payload.sender === "string" ? payload.sender : "";
    if ((payload?.conversation || latestNotice.conversation) && payload?.conversation !== latestNotice.conversation) {
      return false;
    }
    if (targetSender && latestNotice.sender && !isGenericSender(targetSender) && !isGenericSender(latestNotice.sender) && targetSender !== latestNotice.sender) {
      return false;
    }
    latestNotice.triggerClick();
    return true;
  };

  function hostWindowState() {
    try {
      return ipcRenderer.sendSync("oa:window-state") || {};
    } catch (error) {
      return {};
    }
  }

  function forwardFlash(enabled) {
    ipcRenderer.send(enabled ? "oa:attention" : "oa:attention-stop");
  }

  const PHOTO_CHANNELS = new Set([
    "show-photo-view",
    "photo-view-params.success",
    "close-photo-view",
    "photo-view-custom-download-ipc",
    "photo-view-share-message-get",
    "photo-view-share-message-callback"
  ]);
  const ipcListeners = new Map();

  function addIpcListener(channel, listener) {
    if (typeof channel !== "string" || typeof listener !== "function") {
      return ipc;
    }
    let list = ipcListeners.get(channel);
    if (!list) {
      list = [];
      ipcListeners.set(channel, list);
    }
    list.push(listener);
    return ipc;
  }

  function removeIpcListener(channel, listener) {
    const list = ipcListeners.get(channel);
    if (!list) {
      return ipc;
    }
    const index = list.indexOf(listener);
    if (index !== -1) {
      list.splice(index, 1);
    }
    return ipc;
  }

  function dispatchBridgeIpc(channel, args) {
    const list = ipcListeners.get(channel);
    if (!list || !list.length) {
      return;
    }
    const event = { sender: ipc };
    list.slice().forEach(function (listener) {
      try {
        listener(event, args);
      } catch (error) {
        noop(error);
      }
    });
  }

  if (typeof ipcRenderer.on === "function") {
    ipcRenderer.on("oa:bridge-ipc", function (_event, channel, args) {
      dispatchBridgeIpc(channel, args);
    });
  }

  const ipc = {
    on: addIpcListener,
    once: function (channel, listener) {
      if (typeof listener !== "function") {
        return ipc;
      }
      const wrapped = function (event, args) {
        removeIpcListener(channel, wrapped);
        listener(event, args);
      };
      return addIpcListener(channel, wrapped);
    },
    off: removeIpcListener,
    addListener: addIpcListener,
    removeListener: removeIpcListener,
    removeAllListeners: function (channel) {
      if (typeof channel === "string") {
        ipcListeners.delete(channel);
      } else {
        ipcListeners.clear();
      }
      return ipc;
    },
    send: function (channel, payload) {
      if (channel === "tray-flash" || channel === "window-flash-frame") {
        const enabled = !payload || payload.flashFrame !== false;
        forwardFlash(enabled);
        if (enabled) {
          scheduleFlashMessage(payload);
        }
      } else if (channel === "cancel-tray-flash") {
        const state = hostWindowState();
        if (state.focused !== false) {
          forwardFlash(false);
        }
      } else if (channel === "open-message-popup-window") {
        forwardFlash(true);
        scheduleFlashMessage(payload);
      } else if (channel === "get-all-support-js-api") {
        const reply = {
          res: JSON.stringify([
            "independentPhotoView",
            "trayFlash",
            "copyImage",
            "pageVisible",
            "fullScreen"
          ])
        };
        if (typeof queueMicrotask === "function") {
          queueMicrotask(function () {
            dispatchBridgeIpc("get-all-support-js-api.result", reply);
          });
        } else {
          dispatchBridgeIpc("get-all-support-js-api.result", reply);
        }
      } else if (PHOTO_CHANNELS.has(channel)) {
        try {
          ipcRenderer.send("oa:photo-ipc", channel, payload);
        } catch (error) {
          noop(error);
        }
      }
      return ipc;
    },
    invoke: function (channel, payload) {
      if (channel === "get-package-info") {
        return Promise.resolve(window.__ET_PACKAGE_INFO || { name: "OA", version: "10.0.0" });
      }
      if (channel === "write-clipboard-text") {
        return writeClipboardText(payload && typeof payload === "object" ? payload.text : payload);
      }
      if (typeof channel === "string" && (channel.indexOf("oa:dialog-") === 0 || channel.indexOf("oa:shell-") === 0)) {
        return ipcRenderer.invoke(channel, payload);
      }
      return Promise.resolve(null);
    },
    sendSync: function (channel, payload) {
      if (typeof channel === "string" && (channel.indexOf("oa:dialog-") === 0 || channel === "oa:get-path")) {
        return ipcRenderer.sendSync(channel, payload);
      }
      return null;
    },
    postMessage: noop,
    sendToHost: noop
  };
  const appStub = {
    getVersion: function () { return "10.0.0"; },
    getName: function () { return "OA"; },
    getPath: function (name) {
      try {
        const value = ipc.sendSync("oa:get-path", typeof name === "string" ? name : "");
        return typeof value === "string" ? value : "";
      } catch (error) {
        return "";
      }
    },
    relaunch: noop,
    exit: noop,
    quit: noop,
    on: noop,
    once: noop
  };
  // Only plain JSON data crosses into the main process: functions and
  // other unserializable values in OA's dialog options are dropped.
  function dialogOptions(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return {};
    }
    try {
      const parsed = JSON.parse(JSON.stringify(value));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch (error) {
      return {};
    }
  }
  const dialogStub = {
    showMessageBox: function (options) { return ipc.invoke("oa:dialog-message", dialogOptions(options)); },
    showMessageBoxSync: function (options) {
      const result = ipc.sendSync("oa:dialog-message-sync", dialogOptions(options));
      return typeof result === "number" ? result : 0;
    },
    showOpenDialog: function (options) { return ipc.invoke("oa:dialog-open", dialogOptions(options)); },
    showOpenDialogSync: function (options) {
      const result = ipc.sendSync("oa:dialog-open-sync", dialogOptions(options));
      return Array.isArray(result) ? result : [];
    },
    showSaveDialog: function (options) { return ipc.invoke("oa:dialog-save", dialogOptions(options)); },
    showSaveDialogSync: function (options) {
      const result = ipc.sendSync("oa:dialog-save-sync", dialogOptions(options));
      return result && typeof result === "object" ? result : { canceled: true };
    }
  };
  const isPhotoViewPage = Boolean(
    window.location
    && typeof window.location.pathname === "string"
    && window.location.pathname.indexOf("/sp/em/photoview") !== -1
  );
  const windowStub = {
    id: 1,
    oliType: isPhotoViewPage ? "photo-view" : "main",
    getType: function () { return isPhotoViewPage ? "photo-view" : "main"; },
    isFocused: function () {
      const state = hostWindowState();
      if (typeof state.focused === "boolean") {
        return state.focused;
      }
      return document.hasFocus();
    },
    isVisible: function () {
      const state = hostWindowState();
      if (typeof state.visible === "boolean") {
        return state.visible;
      }
      return true;
    },
    isMaximized: function () { return false; },
    isFullScreen: function () { return false; },
    isDestroyed: function () { return false; },
    isMinimized: function () {
      const state = hostWindowState();
      return state.minimized === true;
    },
    getTitle: function () { return document.title; },
    getBounds: function () {
      return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    },
    getBrowserViews: function () { return []; },
    focus: noop,
    show: noop,
    hide: function () {
      if (isPhotoViewPage) {
        ipc.send("close-photo-view");
      }
    },
    close: function () {
      if (isPhotoViewPage) {
        ipc.send("close-photo-view");
      }
    },
    flashFrame: function (flag) {
      const enabled = flag !== false;
      forwardFlash(enabled);
      if (enabled) {
        scheduleFlashMessage();
      }
    },
    setSkipTaskbar: noop,
    setIgnoreMouseEvents: noop,
    redirectIpcToAllViews: noop,
    on: function () { return windowStub; },
    once: function () { return windowStub; },
    removeAllListeners: function () { return windowStub; },
    webContents: { send: noop, on: noop }
  };
  const webContentsStub = {
    id: 1,
    oliType: isPhotoViewPage ? "photo-view" : "navView",
    getURL: function () { return window.location.href; },
    isDestroyed: function () { return false; },
    reloadIgnoringCache: noop,
    setZoomFactor: noop,
    setVisualZoomLevelLimits: noop,
    setZoomLevel: noop,
    getZoomFactor: function () { return 1; },
    setWindowOpenHandler: noop,
    destroy: noop,
    on: noop,
    once: noop,
    send: noop,
    executeJavaScript: function () { return Promise.resolve(null); },
    getOwnerBrowserWindow: function () { return windowStub; }
  };
  async function writeClipboardText(text) {
    if (typeof text !== "string" || !text.length) {
      throw new Error("未能写入系统剪贴板，请重试复制");
    }
    let ok = false;
    if (typeof ipcRenderer.invoke === "function") {
      ok = await ipcRenderer.invoke("oa:clipboard-write-text", text);
    } else if (typeof ipcRenderer.sendSync === "function") {
      ok = ipcRenderer.sendSync("oa:clipboard-write-text", text);
    }
    if (ok !== true) {
      throw new Error("未能写入系统剪贴板，请重试复制");
    }
    return true;
  }

  async function writeClipboardImage(image) {
    const data = typeof image === "string" ? image : image?.toDataURL?.();
    if (typeof data !== "string" || await ipcRenderer.invoke("oa:clipboard-write-image", data) !== true) {
      throw new Error("未能复制图片到系统剪贴板");
    }
    return true;
  }

  const remote = {
    app: appStub,
    dialog: dialogStub,
    getCurrentWindow: function () { return windowStub; },
    getCurrentWebContents: function () { return webContentsStub; },
    Notification: ClientNotification,
    BrowserWindow: {
      getAllWindows: function () { return [windowStub]; },
      fromWebContents: function () { return windowStub; },
      fromId: function () { return windowStub; }
    },
    screen: {
      getPrimaryDisplay: function () {
        return { workAreaSize: { width: window.screen.width, height: window.screen.height } };
      }
    },
    nativeImage: {
      createFromDataURL(data) {
        return { toDataURL: () => data, isEmpty: () => !/^data:image\/(?:png|jpeg);base64,/i.test(data) };
      }
    },
    clipboard: {
      writeImage: writeClipboardImage,
      writeText: writeClipboardText,
      readText: function () { return ""; }
    },
    shell: {
      openExternal: function (url) { return ipc.invoke("oa:shell-open-external", typeof url === "string" ? url : ""); },
      openPath: function (target) { return ipc.invoke("oa:shell-open-path", typeof target === "string" ? target : ""); },
      showItemInFolder: function (target) { return ipc.invoke("oa:shell-show-item", typeof target === "string" ? target : ""); }
    }
  };
  const electronStub = {
    ipcRenderer: ipc,
    remote: remote,
    Notification: ClientNotification,
    app: appStub,
    clipboard: remote.clipboard,
    shell: remote.shell,
    webFrame: { setZoomFactor: noop, setZoomLevel: noop, setVisualZoomLevelLimits: noop, getZoomFactor: function () { return 1; } },
    nativeImage: remote.nativeImage
  };
  const osStub = {
    platform: function () { return "win32"; },
    release: function () { return "10.0.26100"; },
    hostname: function () { return "oa-shell"; },
    userInfo: function () { return {}; },
    networkInterfaces: function () { return {}; }
  };
  window.emRequire = function (name) {
    if (name === "electron-store") {
      return ClientStore;
    }
    if (name === "@electron/remote") {
      return remote;
    }
    if (name === "electron") {
      return electronStub;
    }
    if (name === "os") {
      return osStub;
    }
    if (name === "url") {
      return {
        format: function () { return ""; },
        parse: function (value) {
          try {
            return new URL(value);
          } catch (error) {
            return {};
          }
        }
      };
    }
    return {};
  };
  window.__ET_PACKAGE_INFO = { name: "OA", version: "10.0.0" };
  window.__ET_PHOTO_MIN_WINDOW_SIZE = [800, 540];
  window.__ET_PHOTO_VIEW_CUSTOMDOWNLOAD = true;
  window.__ET_COPY_IMAGE_SUPPORT = true;
  const originalAddEventListener = window.addEventListener.bind(window);
  const originalRemoveEventListener = window.removeEventListener.bind(window);
  const focusListeners = new WeakMap();
  window.addEventListener = function (type, listener, options) {
    if (type === "focus" && typeof listener === "function" && !listener.__oaShell) {
      let wrapped = focusListeners.get(listener);
      if (!wrapped) {
        wrapped = function (event) {
          const state = hostWindowState();
          if (state.focused === false) {
            return;
          }
          return listener.call(this, event);
        };
        wrapped.__oaShell = true;
        focusListeners.set(listener, wrapped);
      }
      return originalAddEventListener(type, wrapped, options);
    }
    return originalAddEventListener(type, listener, options);
  };
  window.removeEventListener = function (type, listener, options) {
    const wrapped = type === "focus" && typeof listener === "function" ? focusListeners.get(listener) : null;
    return originalRemoveEventListener(type, wrapped || listener, options);
  };
  let reportedBlur = false;
  let blurTicks = 0;
  setInterval(function () {
    const state = hostWindowState();
    if (state.focused === false) {
      if (!reportedBlur || blurTicks < 8) {
        reportedBlur = true;
        blurTicks += 1;
        window.dispatchEvent(new Event("blur"));
      }
      return;
    }
    reportedBlur = false;
    blurTicks = 0;
  }, 500);
  try {
    delete window.require;
  } catch (error) {
    noop(error);
  }
}

installClientBridge();
