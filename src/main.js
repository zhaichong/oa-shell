const { app, BaseWindow, WebContentsView, Tray, Menu, Notification, nativeImage, ipcMain, session, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { createStore } = require("./store");
const { buildSnapshot, collectReminders, dateKey, normalizeDay, formatMinutes } = require("./overtime");
const { monthRange, normalizeAttendance, pageFetchExpression } = require("./attendance");
const { createWinFlash } = require("./win-flash");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let tray = null;
let oaView = null;
let sidebarView = null;
let store = null;
let data = null;
let quitting = false;
let oaStatus = { state: "loading", message: "正在打开 OA" };
let reminderTimer = null;
let hideHinted = false;
let openedMessages = false;
let messageOpening = false;
let messageTries = 0;
let trayIcon = null;
let trayAlertIcon = null;
let messageOverlayIcon = null;
let hasUnread = false;
let trayBlinkTimer = null;
let attentionToken = 0;
let attendanceToken = 0;
let attendance = emptyAttendance();
let flasher = null;
let weAreForeground = false;
let foregroundTimer = null;

const APP_USER_MODEL_ID = "亚华 OA";


function oaWebPreferences() {
  return {
    preload: path.join(__dirname, "oa-preload.js"),
    contextIsolation: false,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: false,
    partition: "persist:oa"
  };
}



function layoutUrl() {
  try {
    return new URL(data.settings.oaUrl).origin + "/";
  } catch (error) {
    return "https://oa.yarward.com:35877/";
  }
}

function withPcClient(agent) {
  const stripped = String(agent || "").replace(/\s+weapp-pc\/\S+/g, "").replace(/\s{2,}/g, " ").trim();
  return stripped + " weapp-pc/10.0.0/oa-shell";
}

function ensureWindowsToastIdentity() {
  if (process.platform !== "win32") {
    return;
  }
  const shortcutPath = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs", "亚华 OA.lnk");
  const details = {
    target: process.execPath,
    cwd: path.resolve(__dirname, ".."),
    args: app.isPackaged ? "" : '"' + path.resolve(__dirname, "..") + '"',
    description: "亚华 OA",
    icon: path.join(__dirname, "..", "assets", "oa-app.ico"),
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID
  };
  const replaced = shell.writeShortcutLink(shortcutPath, "replace", details);
  if (!replaced) {
    shell.writeShortcutLink(shortcutPath, "create", details);
  }
}

function emptyAttendance(date) {
  const range = monthRange(date || new Date());
  return {
    state: "loading",
    message: "正在读取本月出勤",
    monthKey: range.monthKey,
    totalText: "",
    totalLabel: "加班",
    details: []
  };
}

function ensureFlasher() {
  if (!flasher) {
    flasher = createWinFlash();
  }
  return flasher;
}

function hwndOf(win) {
  if (!win || win.isDestroyed()) {
    return "";
  }
  try {
    const handle = win.getNativeWindowHandle();
    if (!handle || !handle.length) {
      return "";
    }
    if (handle.length >= 8) {
      return handle.readBigUInt64LE(0).toString();
    }
    return handle.readUInt32LE(0).toString();
  } catch (error) {
    return "";
  }
}

function noteAttention(line) {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "attention.log"), new Date().toISOString() + " " + line + "\n");
  } catch (error) {
    return;
  }
}

async function refreshForeground() {
  const hwnd = hwndOf(mainWindow);
  if (!hwnd || !mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible() || mainWindow.isMinimized()) {
    weAreForeground = false;
    return false;
  }
  const foreground = await ensureFlasher().foreground();
  weAreForeground = foreground === hwnd;
  return weAreForeground;
}

function setUnreadIndicator(unread) {
  hasUnread = unread;
  if (!unread && trayBlinkTimer) {
    clearInterval(trayBlinkTimer);
    trayBlinkTimer = null;
  }
  if (tray && trayIcon) {
    if (!trayBlinkTimer) {
      tray.setImage(unread ? trayAlertIcon : trayIcon);
    }
    if (unread && !trayBlinkTimer) {
      let showUnread = true;
      trayBlinkTimer = setInterval(() => {
        if (!hasUnread || !tray) {
          return;
        }
        showUnread = !showUnread;
        tray.setImage(showUnread ? trayAlertIcon : trayIcon);
      }, 1000);
    }
    tray.setToolTip(unread ? "亚华 OA · 有新消息，点击查看" : "亚华 OA");
  }
  if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.setOverlayIcon === "function") {
    mainWindow.setOverlayIcon(unread ? messageOverlayIcon : null, unread ? "有新消息" : "");
  }
}

function stopWindowFlash() {
  const hwnd = hwndOf(mainWindow);
  if (hwnd) {
    ensureFlasher().stop(hwnd).catch(() => {});
  }
  if (mainWindow && !mainWindow.isDestroyed() && typeof mainWindow.flashFrame === "function") {
    mainWindow.flashFrame(false);
  }
}

function stopAttention() {
  attentionToken += 1;
  setUnreadIndicator(false);
  stopWindowFlash();
}

function flashTaskbar() {
  if (!mainWindow || mainWindow.isDestroyed() || typeof mainWindow.flashFrame !== "function") {
    return;
  }
  if (weAreForeground) {
    return;
  }
  mainWindow.flashFrame(true);
}

async function attractAttention() {
  const token = ++attentionToken;
  const foreground = await refreshForeground();
  if (token !== attentionToken || foreground) {
    return;
  }
  setUnreadIndicator(true);
  // A hidden window has no taskbar button. Keep it hidden and use the tray notification.
  if (!mainWindow || mainWindow.isDestroyed() || (!mainWindow.isVisible() && !mainWindow.isMinimized())) {
    return;
  }
  const hwnd = hwndOf(mainWindow);
  if (!hwnd) {
    flashTaskbar();
    noteAttention("flash missing-hwnd");
    return;
  }
  try {
    const result = await ensureFlasher().flash(hwnd);
    noteAttention("flash " + hwnd + " " + result + " foreground=" + weAreForeground);
    if (token === attentionToken && (!result || result.indexOf("ok") !== 0)) {
      flashTaskbar();
    }
  } catch (error) {
    noteAttention("flash failed");
    if (token === attentionToken) {
      flashTaskbar();
    }
  }
}

function syncPageFocus(focused) {
  if (!oaView || oaView.webContents.isDestroyed()) {
    return;
  }
  const script = focused ? "window.dispatchEvent(new Event('focus'))" : "window.dispatchEvent(new Event('blur'))";
  oaView.webContents.executeJavaScript(script).catch(() => {});
}

async function refreshAttendance() {
  const token = ++attendanceToken;
  const range = monthRange(new Date());
  attendance = { ...attendance, state: "loading", message: "正在读取本月出勤" };
  publish();
  if (!oaView || oaView.webContents.isDestroyed()) {
    attendance = { ...emptyAttendance(), state: "error", message: "OA 还没打开" };
    publish();
    return;
  }
  try {
    const result = await oaView.webContents.executeJavaScript(pageFetchExpression(range), true);
    if (token !== attendanceToken) {
      return;
    }
    const next = normalizeAttendance(result && result.statis, result && result.detail, range, result && result.calendar);
    if (next.state === "error" && (!next.message || next.message === "not-json")) {
      next.state = "login";
      next.message = "登录 OA 后才能读取本月出勤";
    } else if (next.state === "ready" && !next.totalText && next.details.length === 0) {
      next.message = "这个月还没有加班记录";
    }
    attendance = next;
  } catch (error) {
    if (token !== attendanceToken) {
      return;
    }
    attendance = { ...emptyAttendance(), state: "error", message: "读取出勤失败，登录 OA 后再刷新" };
  }
  publish();
}

function openWorkMessages() {
  if (!oaView || oaView.webContents.isDestroyed() || openedMessages || messageOpening || messageTries > 24) {
    return;
  }
  messageTries += 1;
  messageOpening = true;
  const script = "(() => { if (document.querySelector('.weapp-main-em:not(.im-hide) .session')) return true; var node = document.querySelector('a[title=\"工作消息\"]'); if (node) node.click(); return false; })()";
  oaView.webContents.executeJavaScript(script).then((clicked) => {
    messageOpening = false;
    if (clicked) {
      openedMessages = true;
      return;
    }
    setTimeout(openWorkMessages, 700);
  }).catch(() => {
    messageOpening = false;
    setTimeout(openWorkMessages, 700);
  });
}

function snapshot() {
  return {
    ...buildSnapshot(data, new Date()),
    oa: oaStatus,
    panelOpen: data.panelOpen === true,
    attendance
  };
}

function publish() {
  if (sidebarView && !sidebarView.webContents.isDestroyed()) {
    sidebarView.webContents.send("state", snapshot());
  }
  updateTrayMenu();
}

function persist() {
  data = store.save(data);
  publish();
}

function clockText(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isSafeWebUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch (error) {
    return false;
  }
}

function layout() {
  if (!mainWindow || !oaView || !sidebarView) {
    return;
  }
  const contentBounds = mainWindow.getContentBounds();
  const width = contentBounds.width;
  const height = contentBounds.height;
  if (data.panelOpen) {
    const sidebarWidth = Math.min(336, width);
    oaView.setBounds({ x: 0, y: 0, width: width - sidebarWidth, height });
    sidebarView.setBounds({ x: width - sidebarWidth, y: 0, width: sidebarWidth, height });
    return;
  }
  oaView.setBounds({ x: 0, y: 0, width, height });
  sidebarView.setBounds({
    x: Math.max(0, width - 36),
    y: Math.max(8, Math.round(height / 2 - 56)),
    width: 36,
    height: 112
  });
}

function showWindow() {
  if (!mainWindow) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
}

function updateTrayMenu() {
  if (!tray) {
    return;
  }
  const view = snapshot();
  const summary = attendance.totalText
    ? attendance.monthKey + " 加班 " + attendance.totalText
    : attendance.message || "本月加班";
  tray.setToolTip(hasUnread ? "亚华 OA · 有新消息，点击查看" : "亚华 OA · " + summary);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: summary, enabled: false },
    { label: "显示消息", click: showWindow },
    { label: data.panelOpen ? "收起加班助手" : "打开加班助手", click: togglePanel },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitting = true;
        app.quit();
      }
    }
  ]));
}

function notify(reminder, options) {
  if (!Notification.isSupported()) {
    return;
  }
  const notice = new Notification({
    title: reminder.title,
    body: reminder.body,
    icon: path.join(__dirname, "..", "assets", "icon.png")
  });
  notice.on("click", showWindow);
  notice.show();
  if (!options || options.attention !== false) {
    attractAttention();
  }
}

function runReminders() {
  const due = collectReminders(data, new Date());
  if (!due.length) {
    publish();
    return;
  }
  due.forEach((reminder) => {
    data.reminders[reminder.dateKey] = data.reminders[reminder.dateKey] || {};
    data.reminders[reminder.dateKey][reminder.id] = true;
    notify(reminder);
  });
  data = store.save(data);
  publish();
}

function todayRecord() {
  const key = dateKey(new Date());
  if (!data.days[key]) {
    data.days[key] = normalizeDay();
  }
  return data.days[key];
}

function togglePanel() {
  data.panelOpen = !data.panelOpen;
  layout();
  persist();
  if (data.panelOpen) {
    refreshAttendance();
  }
}

function createViews() {
  const oaSession = session.fromPartition("persist:oa");
  const clientAgent = withPcClient(oaSession.getUserAgent());
  oaSession.setUserAgent(clientAgent);
  oaSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = new Set(["notifications", "media", "clipboard-read", "clipboard-sanitized-write", "fullscreen"]);
    let host = "";
    try {
      host = new URL(details.requestingUrl || webContents.getURL()).hostname;
    } catch (error) {
      host = "";
    }
    callback(host === "oa.yarward.com" && allowed.has(permission));
  });

  oaView = new WebContentsView({
    webPreferences: oaWebPreferences()
  });
  sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.contentView.addChildView(oaView);
  mainWindow.contentView.addChildView(sidebarView);

  oaView.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSafeWebUrl(url)) {
      return { action: "deny" };
    }
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        width: 1100,
        height: 760,
        autoHideMenuBar: true,
        backgroundColor: "#ffffff",
        webPreferences: oaWebPreferences()
      }
    };
  });
  oaView.webContents.on("will-navigate", (event, url) => {
    if (!isSafeWebUrl(url)) {
      event.preventDefault();
    }
  });
  oaView.webContents.on("did-start-loading", () => {
    oaStatus = { state: "loading", message: "正在打开 OA" };
    publish();
  });
  oaView.webContents.on("dom-ready", () => {
    oaView.webContents.insertCSS(fs.readFileSync(path.join(__dirname, "..", "renderer", "oa-theme.css"), "utf8")).catch(() => {});
  });
  oaView.webContents.on("did-finish-load", () => {
    oaStatus = { state: "ready", message: "OA 已打开" };
    publish();
    openWorkMessages();
    setTimeout(refreshAttendance, 1500);
    setTimeout(refreshAttendance, 8000);
    if (mainWindow && !mainWindow.isFocused()) {
      syncPageFocus(false);
    }
  });
  sidebarView.webContents.on("will-navigate", (event) => event.preventDefault());
  sidebarView.webContents.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  oaView.webContents.setUserAgent(clientAgent);
  oaView.webContents.loadURL(layoutUrl());


}

function createWindow() {
  const bounds = data.window || { width: 1440, height: 900 };
  mainWindow = new BaseWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    x: Number.isInteger(bounds.x) && bounds.x >= 0 && bounds.x < 2400 ? bounds.x : undefined,
    y: Number.isInteger(bounds.y) && bounds.y >= 0 && bounds.y < 1400 ? bounds.y : undefined,
    minWidth: 1100,
    minHeight: 700,
    title: "亚华 OA",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "..", "assets", "icon.png")
  });
  createViews();
  layout();
  mainWindow.on("resize", () => {
    layout();
    saveBounds();
  });
  mainWindow.on("move", saveBounds);
  mainWindow.on("focus", () => {
    refreshForeground().then((foreground) => {
      if (!foreground) {
        syncPageFocus(false);
        return;
      }
      stopAttention();
      syncPageFocus(true);
    });
  });
  mainWindow.on("blur", () => {
    weAreForeground = false;
    syncPageFocus(false);
  });
  mainWindow.on("minimize", () => syncPageFocus(false));
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      mainWindow.hide();
      syncPageFocus(false);
      if (!hideHinted) {
        hideHinted = true;
        notify({
          title: "亚华 OA 仍在运行",
          body: "窗口已最小化到托盘。右键托盘图标可以选择退出。"
        }, { attention: false });
      }
    }
  });
}

function saveBounds() {
  if (!mainWindow) {
    return;
  }
  const bounds = mainWindow.getBounds();
  data.window = bounds;
  data = store.save(data);
}

function registerIpc() {
  ipcMain.handle("state:get", () => snapshot());
  ipcMain.handle("panel:toggle", () => {
    togglePanel();
    return snapshot();
  });
  ipcMain.handle("day:punch", (_event, type) => {
    const record = todayRecord();
    const time = clockText(new Date());
    if (type === "in") {
      record.checkIn = time;
    } else if (type === "out") {
      record.checkOut = time;
    }
    persist();
    runReminders();
    return snapshot();
  });
  ipcMain.handle("day:save", (_event, patch) => {
    const record = todayRecord();
    const next = normalizeDay({ ...record, ...patch });
    data.days[dateKey(new Date())] = next;
    persist();
    return snapshot();
  });
  ipcMain.handle("day:clear", () => {
    delete data.days[dateKey(new Date())];
    persist();
    return snapshot();
  });
  ipcMain.handle("settings:save", (_event, patch) => {
    data.settings = { ...data.settings, ...patch };
    persist();
    return snapshot();
  });
  ipcMain.handle("oa:back", () => {
    if (oaView.webContents.canGoBack()) {
      oaView.webContents.goBack();
    }
  });
  ipcMain.handle("oa:forward", () => {
    if (oaView.webContents.canGoForward()) {
      oaView.webContents.goForward();
    }
  });
  ipcMain.handle("oa:reload", () => oaView.webContents.reload());
  ipcMain.handle("oa:home", () => oaView.webContents.loadURL(layoutUrl()));
  ipcMain.on("oa:window-state", (event) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    event.returnValue = {
      focused: weAreForeground,
      visible: !!(win && win.isVisible()),
      minimized: !!(win && win.isMinimized())
    };
  });
  ipcMain.on("oa:attention", () => attractAttention());
  ipcMain.on("oa:attention-stop", () => stopAttention());
  ipcMain.on("oa:show", () => showWindow());
  ipcMain.handle("attendance:refresh", async () => {
    await refreshAttendance();
    return snapshot();
  });
  ipcMain.handle("oa:open-external", () => shell.openExternal(oaView.webContents.getURL() || data.settings.oaUrl));
}

function createTray() {
  trayIcon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "icon.png")).resize({ width: 16, height: 16 });
  trayAlertIcon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "tray-alert.png")).resize({ width: 16, height: 16 });
  messageOverlayIcon = nativeImage.createFromPath(path.join(__dirname, "..", "assets", "unread-overlay.png")).resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.on("click", showWindow);
  updateTrayMenu();
}

if (gotLock) {
app.setName("亚华 OA");
app.setAppUserModelId(APP_USER_MODEL_ID);
app.whenReady().then(() => {
  store = createStore(path.join(app.getPath("userData"), "overtime.json"));
  data = store.load();
  ensureWindowsToastIdentity();
  registerIpc();
  createWindow();
  createTray();
  refreshForeground();
  foregroundTimer = setInterval(refreshForeground, 500);
});

app.on("second-instance", showWindow);
app.on("before-quit", () => {
  quitting = true;
  if (trayBlinkTimer) {
    clearInterval(trayBlinkTimer);
  }
  if (reminderTimer) {
    clearInterval(reminderTimer);
  }
  if (foregroundTimer) {
    clearInterval(foregroundTimer);
  }
  if (flasher) {
    flasher.close();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
}
