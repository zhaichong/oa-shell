const { ipcRenderer } = require("electron");

function noop() {}

function signalAttention() {
  try {
    ipcRenderer.send("oa:attention");
  } catch (error) {
    noop(error);
  }
}

function installAttentionHook(NativeNotification) {
  if (!NativeNotification || NativeNotification.__oaShell) {
    return NativeNotification;
  }
  function ShellNotification(title, options) {
    signalAttention();
    const notice = new NativeNotification(title, options || {});
    notice.addEventListener("click", function () {
      ipcRenderer.send("oa:show");
    });
    return notice;
  }
  ShellNotification.prototype = NativeNotification.prototype;
  ShellNotification.__oaShell = true;
  Object.defineProperty(ShellNotification, "permission", {
    configurable: true,
    get: function () {
      return NativeNotification.permission;
    }
  });
  ShellNotification.requestPermission = function (callback) {
    return NativeNotification.requestPermission(callback);
  };
  window.Notification = ShellNotification;
  return ShellNotification;
}

function createClientNotification(NativeNotification) {
  function ClientNotification(options) {
    const payload = options || {};
    const title = payload.title || "";
    const body = payload.body || "";
    signalAttention();
    this._click = [];
    try {
      this._notice = new NativeNotification(title, { body: body });
      const self = this;
      this._notice.addEventListener("click", function () {
        ipcRenderer.send("oa:show");
        self._click.forEach(function (listener) {
          listener();
        });
      });
    } catch (error) {
      this._notice = null;
    }
  }
  ClientNotification.prototype.on = function (event, listener) {
    if (event === "click" && typeof listener === "function") {
      this._click.push(listener);
    }
    return this;
  };
  ClientNotification.prototype.once = ClientNotification.prototype.on;
  ClientNotification.prototype.removeListener = function () {
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
    if (this._notice) {
      this._notice.close();
    }
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
  const ClientNotification = createClientNotification(NativeNotification);
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

  const ipc = {
    on: function () { return ipc; },
    once: function () { return ipc; },
    off: function () { return ipc; },
    addListener: function () { return ipc; },
    removeListener: function () { return ipc; },
    removeAllListeners: function () { return ipc; },
    send: function (channel, payload) {
      if (channel === "tray-flash" || channel === "window-flash-frame") {
        forwardFlash(!payload || payload.flashFrame !== false);
      } else if (channel === "cancel-tray-flash") {
        const state = hostWindowState();
        if (state.focused !== false) {
          forwardFlash(false);
        }
      } else if (channel === "open-message-popup-window") {
        forwardFlash(true);
      }
      return ipc;
    },
    invoke: function () { return Promise.resolve(null); },
    sendSync: function () { return null; },
    postMessage: noop,
    sendToHost: noop
  };
  const appStub = {
    getVersion: function () { return "10.0.0"; },
    getName: function () { return "亚华 OA"; },
    getPath: function () { return ""; },
    relaunch: noop,
    exit: noop,
    quit: noop,
    on: noop,
    once: noop
  };
  const dialogStub = {
    showMessageBox: function () { return Promise.resolve({ response: 0 }); },
    showOpenDialog: function () { return Promise.resolve({ canceled: true, filePaths: [] }); },
    showOpenDialogSync: function () { return []; }
  };
  const windowStub = {
    id: 1,
    oliType: "main",
    getType: function () { return "main"; },
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
    hide: noop,
    flashFrame: function (flag) { forwardFlash(flag !== false); },
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
    oliType: "navView",
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
    nativeImage: { createFromDataURL: function () { return null; } },
    clipboard: {
      writeImage: noop,
      writeText: noop,
      readText: function () { return ""; }
    },
    shell: {
      openExternal: function () { return Promise.resolve(); },
      openPath: function () { return Promise.resolve(""); },
      showItemInFolder: noop
    }
  };
  const electronStub = {
    ipcRenderer: ipc,
    remote: remote,
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
  window.__ET_PACKAGE_INFO = { name: "亚华 OA", version: "10.0.0" };
  const originalAddEventListener = window.addEventListener.bind(window);
  window.addEventListener = function (type, listener, options) {
    if (type === "focus" && typeof listener === "function" && !listener.__oaShell) {
      const wrapped = function (event) {
        const state = hostWindowState();
        if (state.focused === false) {
          return;
        }
        return listener.call(this, event);
      };
      wrapped.__oaShell = true;
      return originalAddEventListener(type, wrapped, options);
    }
    return originalAddEventListener(type, listener, options);
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
