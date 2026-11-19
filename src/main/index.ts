import {
  app,
  BaseWindow,
  BrowserWindow,
  clipboard,
  ClipboardItem,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  WebContentsView,
  type Rectangle,
  type WebContents
} from "electron"
import fs from "node:fs"
import path from "node:path"
import { monthRange, normalizeAttendance, pageFetchExpression } from "../attendance.js"
import { createAttention } from "../attention.js"
import { createBoundsSaver } from "../bounds-saver.js"
import { addReminder, cancelReminder, collectDueReminders, formatOvertime, helpText, parseCommand } from "../assistant.js"
import { createStore } from "../store.js"
import { createIntegrationStore, previewTasks } from "../integrations.js"
import { createAIStore, createAIService } from "../ai-gateway.js"
import { createCodexRunner } from "../codex-runner.js"
import { createPopupRegistry } from "../popup-windows.js"
import { buildPopupHtml, computePopupBounds, createPopupController, normalizeMessagePayload } from "../message-popup.js"
import { normalizeAvatar } from "../assistant-avatar.js"
import { createWinFlash } from "../win-flash.js"
import type { AIModel, AttendanceState, ConnectionConfig, DeskState } from "../shared/desk"
import { preloadPath, projectRoot, rendererHtml, resourcePath } from "./paths"

const APP_USER_MODEL_ID = "OA"
const PHOTO_IDLE_MS = 30_000
const SIDEBAR_IDLE_MS = 60_000
let integrations: ReturnType<typeof createIntegrationStore>
let aiStore: ReturnType<typeof createAIStore>
let aiService: ReturnType<typeof createAIService>
let sandboxRunner: ReturnType<typeof createCodexRunner>
let cachedAIModels: AIModel[] = []
let lastAttendanceRefreshAt = 0
const integrationLogins = new Map<string, BrowserWindow>()

function cleanBrowserUserAgent(raw: string): string {
  return String(raw || "")
    .replace(/\s+\S*[^\x20-\x7e]\S*\/[^\s]+/g, "")
    .replace(/\s+Electron\/[^\s]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

async function readBrowserOriginAuth(config: { id: string; auth: string; baseUrl: string }): Promise<{ authorization?: string }> {
  if (config.auth !== "browser") {
    return {}
  }
  const origin = new URL(config.baseUrl).origin
  const existing = integrationLogins.get(config.id)
  const extractTokenScript = "(() => { try { const t = localStorage.getItem('token'); const h = localStorage.getItem('tokenHead') || 'Bearer'; return t ? (h + ' ' + t) : ''; } catch { return ''; } })()"
  if (existing && !existing.isDestroyed()) {
    try {
      const currentOrigin = new URL(existing.webContents.getURL()).origin
      if (currentOrigin === origin) {
        const auth = await existing.webContents.executeJavaScript(extractTokenScript)
        if (typeof auth === "string" && auth) {
          return { authorization: auth }
        }
      }
    } catch {}
  }
  const partSession = session.fromPartition("persist:integration-" + config.id)
  const ua = cleanBrowserUserAgent(partSession.getUserAgent())
  if (ua) partSession.setUserAgent(ua)
  const probeWin = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      partition: "persist:integration-" + config.id
    }
  })
  if (ua) probeWin.webContents.setUserAgent(ua)
  try {
    await Promise.race([
      probeWin.loadURL(config.baseUrl),
      new Promise((resolve) => setTimeout(resolve, 4000))
    ])
    const currentOrigin = (() => {
      try { return new URL(probeWin.webContents.getURL()).origin } catch { return "" }
    })()
    if (currentOrigin === origin) {
      const auth = await probeWin.webContents.executeJavaScript(extractTokenScript)
      if (typeof auth === "string" && auth) {
        return { authorization: auth }
      }
    }
  } catch {
    return {}
  } finally {
    if (!probeWin.isDestroyed()) {
      probeWin.destroy()
    }
  }
  return {}
}

async function readIntegrationTasks(id: string) {
  const { config, secret } = await integrations.resolve(id)
  const partSession = session.fromPartition("persist:integration-" + config.id)
  const ua = cleanBrowserUserAgent(partSession.getUserAgent())
  if (ua) partSession.setUserAgent(ua)
  const extraAuth = config.kind === "qianfan" ? await readBrowserOriginAuth(config) : {}
  return previewTasks(config, secret, (url, options) => partSession.fetch(String(url), options), extraAuth)
}
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

interface DayRecord {
  checkIn: string
  checkOut: string
  applied: boolean
  forceWorkday: boolean | null
}

interface SubmittedOvertimeRecord {
  period?: string
  flowNo: string
  title: string
  at: string
}

interface AppData {
  settings: {
    oaUrl: string
    [key: string]: unknown
  }
  days: Record<string, DayRecord>
  reminders: Record<string, Record<string, boolean>>
  tasks: AssistantTask[]
  submittedOvertimeDates?: Record<string, SubmittedOvertimeRecord>
  window: Partial<Rectangle> | null
  panelOpen: boolean
  assistantAvatar: string
}

interface AssistantTask {
  id: string
  at: string
  text: string
  dateKey: string
  fired: boolean
  cancelled: boolean
}

interface AssistantResult {
  ok: boolean
  message: string
}

let mainWindow: BaseWindow | null = null
let tray: Tray | null = null
let oaView: WebContentsView | null = null
let sidebarView: WebContentsView | null = null
let sidebarIdleTimer: ReturnType<typeof setTimeout> | null = null
let sidebarSession: string | null = null
let store!: ReturnType<typeof createStore>
let data!: AppData
let quitting = false
let oaStatus = { state: "loading", message: "正在打开 OA" }
let openedMessages = false
let messageOpening = false
let messageTries = 0
let trayIcon: Electron.NativeImage | null = null
let trayBlankIcon: Electron.NativeImage | null = null
let attendanceToken = 0
let attendanceTask: Promise<void> | null = null
let attendance: AttendanceState = emptyAttendance()
let flasher: ReturnType<typeof createWinFlash> | null = null
let foregroundTimer: NodeJS.Timeout | null = null
let assistantTimer: NodeJS.Timeout | null = null
let boundsSaver: { submit: (bounds: Rectangle) => void; flush: () => void } | null = null
let trayMenuKey = ""
let themeCss = ""

const POPUP_OPEN_URL = "https://oa-popup.local/open"
const POPUP_CLOSE_URL = "https://oa-popup.local/close"
let messagePopupWindow: BrowserWindow | null = null
let popupReady = false
type PopupMessage = { sender: string; content: string; conversation?: string }
let pendingPopupPayload: PopupMessage | null = null

let photoViewWindow: BrowserWindow | null = null
let photoIdleTimer: ReturnType<typeof setTimeout> | null = null
let photoViewLoaded = false
let pendingPhotoParams: unknown = null
let photoParamsTimer: NodeJS.Timeout | null = null

function clearPhotoParamsTimer(): void {
  if (photoParamsTimer) {
    clearInterval(photoParamsTimer)
    photoParamsTimer = null
  }
}

function photoViewUrl(): string {
  return layoutUrl() + "sp/em/photoview"
}

function sendPhotoParams(win: BrowserWindow, args: unknown): void {
  clearPhotoParamsTimer()
  if (win.isDestroyed() || win.webContents.isDestroyed()) {
    return
  }
  win.webContents.send("oa:bridge-ipc", "photo-view-params", args)
  let tries = 0
  photoParamsTimer = setInterval(() => {
    tries += 1
    if (tries > 50 || win.isDestroyed() || win.webContents.isDestroyed() || !win.isVisible()) {
      clearPhotoParamsTimer()
      return
    }
    win.webContents.send("oa:bridge-ipc", "photo-view-params", args)
  }, 80)
}

function ensurePhotoViewWindow(): BrowserWindow {
  if (photoViewWindow && !photoViewWindow.isDestroyed()) {
    const currentUrl = photoViewWindow.webContents.getURL()
    if (photoViewLoaded && currentUrl && currentUrl.indexOf("/sp/em/photoview") === -1) {
      photoViewLoaded = false
      photoViewWindow.loadURL(photoViewUrl()).catch(() => {})
    }
    return photoViewWindow
  }
  photoViewLoaded = false
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 800,
    minHeight: 540,
    title: "图片预览",
    autoHideMenuBar: true,
    backgroundColor: "#14181f",
    icon: resourcePath("assets", "icon.png"),
    show: false,
    webPreferences: oaWebPreferences()
  })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeWebUrl(url)) {
      shell.openExternal(url).catch(() => {})
    }
    return { action: "deny" }
  })
  win.webContents.on("will-navigate", (event, url) => {
    if (!isSafeWebUrl(url)) {
      event.preventDefault()
    }
  })
  win.webContents.on("dom-ready", () => {
    win.webContents.insertCSS(oaTheme()).catch(() => {})
  })
  win.webContents.on("did-finish-load", () => {
    photoViewLoaded = true
    if (pendingPhotoParams !== null && win.isVisible()) {
      sendPhotoParams(win, pendingPhotoParams)
    }
  })
  const cancelIdleReclaim = (): void => {
    if (photoIdleTimer) clearTimeout(photoIdleTimer)
    photoIdleTimer = null
  }
  win.on("show", cancelIdleReclaim)
  win.on("hide", () => {
    cancelIdleReclaim()
    photoIdleTimer = setTimeout(() => {
      photoIdleTimer = null
      if (!win.isDestroyed() && !win.isVisible()) win.destroy()
    }, PHOTO_IDLE_MS)
  })
  win.on("close", (event) => {
    if (!quitting) {
      event.preventDefault()
      clearPhotoParamsTimer()
      pendingPhotoParams = null
      win.hide()
      if (!win.webContents.isDestroyed()) {
        win.webContents.send("oa:bridge-ipc", "hide-photo-view", {})
      }
    }
  })
  win.on("closed", () => {
    cancelIdleReclaim()
    clearPhotoParamsTimer()
    if (photoViewWindow === win) {
      photoViewWindow = null
      photoViewLoaded = false
      pendingPhotoParams = null
    }
  })
  win.loadURL(photoViewUrl()).catch(() => {})
  photoViewWindow = win
  return win
}

function showPhotoView(args: unknown): void {
  const win = ensurePhotoViewWindow()
  pendingPhotoParams = args
  if (win.isMinimized()) {
    win.restore()
  }
  win.show()
  win.focus()
  if (oaView && !oaView.webContents.isDestroyed()) {
    oaView.webContents.send("oa:image-preview-ready")
  }
  if (photoViewLoaded) {
    sendPhotoParams(win, args)
  }
}

function hidePhotoView(): void {
  clearPhotoParamsTimer()
  pendingPhotoParams = null
  if (photoViewWindow && !photoViewWindow.isDestroyed()) {
    photoViewWindow.hide()
    if (!photoViewWindow.webContents.isDestroyed()) {
      photoViewWindow.webContents.send("oa:bridge-ipc", "hide-photo-view", {})
    }
  }
}

const popupController = createPopupController({
  showPopup: (payload) => renderAndShowPopup(payload),
  hidePopup: () => hideMessagePopup(),
  durationMs: 5000
})

function ensurePopupWindow(): BrowserWindow {
  if (messagePopupWindow && !messagePopupWindow.isDestroyed()) {
    return messagePopupWindow
  }
  popupReady = false
  const win = new BrowserWindow({
    width: 336,
    height: 116,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: false,
    show: false,
    transparent: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  win.setAlwaysOnTop(true, "pop-up-menu")
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  win.webContents.on("will-navigate", (event, url) => {
    event.preventDefault()
    if (url === POPUP_OPEN_URL) {
      const active = popupController.current()
      popupController.dismiss()
      showWindow()
      acknowledge()
      if (data?.panelOpen) {
        setAssistantOpen(false)
      }
      if (oaView && !oaView.webContents.isDestroyed()) {
        oaView.webContents.send("oa:popup-click", active || {})
      }
      return
    }
    if (url === POPUP_CLOSE_URL) {
      popupController.dismiss()
    }
  })
  win.webContents.once("did-finish-load", () => {
    popupReady = true
    if (pendingPopupPayload && popupController.isOpen()) {
      const latest = pendingPopupPayload
      pendingPopupPayload = null
      renderAndShowPopup(latest)
    }
  })
  win.on("closed", () => {
    if (messagePopupWindow === win) {
      messagePopupWindow = null
      popupReady = false
    }
  })
  win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(buildPopupHtml()))
  messagePopupWindow = win
  return win
}

function renderAndShowPopup(payload: PopupMessage): void {
  const win = ensurePopupWindow()
  pendingPopupPayload = payload
  if (!popupReady) {
    return
  }
  pendingPopupPayload = null
  const bounds = computePopupBounds(screen.getPrimaryDisplay().workArea)
  win.setBounds(bounds)
  win.setAlwaysOnTop(true, "pop-up-menu")
  const script = "window.__renderPopup && window.__renderPopup(" + JSON.stringify(payload) + ")"
  win.webContents.executeJavaScript(script).then(() => {
    if (!win.isDestroyed() && popupController.isOpen()) {
      win.setBounds(computePopupBounds(screen.getPrimaryDisplay().workArea))
      win.setAlwaysOnTop(true, "pop-up-menu")
      win.showInactive()
    }
  }).catch(() => {
    if (!win.isDestroyed() && popupController.isOpen()) {
      win.showInactive()
    }
  })
}

function hideMessagePopup(): void {
  pendingPopupPayload = null
  if (messagePopupWindow && !messagePopupWindow.isDestroyed()) {
    messagePopupWindow.hide()
  }
}

const attention = createAttention({
  getWindow: () => mainWindow,
  getTray: () => tray,
  getIcons: () => ({
    normal: trayIcon,
    blank: trayBlankIcon,
    windowIcon: taskbarIconPath()
  }),
  flasher: {
    foreground: () => ensureFlasher().foreground(),
    flash: (hwnd: string) => ensureFlasher().flash(hwnd),
    stop: (hwnd: string) => ensureFlasher().stop(hwnd),
    setIcon: (hwnd: string, iconPath: string) => ensureFlasher().setIcon(hwnd, iconPath)
  },
  note: noteAttention
})

function oaWebPreferences(): Electron.WebPreferences {
  return {
    preload: preloadPath("oa.js"),
    contextIsolation: false,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: false,
    partition: "persist:oa"
  }
}

function layoutUrl(): string {
  try {
    return new URL(data?.settings?.oaUrl || "").origin + "/"
  } catch (error) {
    return "https://oa.yarward.com:35877/"
  }
}

function withPcClient(agent: string): string {
  const stripped = String(agent || "").replace(/\s+weapp-pc\/\S+/g, "").replace(/\s{2,}/g, " ").trim()
  return stripped + " weapp-pc/10.0.0/oa-shell"
}

function ensureWindowsToastIdentity(): void {
  if (process.platform !== "win32") {
    return
  }
  const programs = path.join(app.getPath("appData"), "Microsoft", "Windows", "Start Menu", "Programs")
  const legacyShortcut = path.join(programs, "亚华 OA.lnk")
  if (fs.existsSync(legacyShortcut)) {
    fs.rmSync(legacyShortcut, { force: true })
  }
  const shortcutPath = path.join(programs, "OA.lnk")
  const details = {
    target: process.execPath,
    cwd: app.isPackaged ? path.dirname(process.execPath) : projectRoot(),
    args: app.isPackaged ? "" : '"' + projectRoot() + '"',
    description: "OA",
    icon: resourcePath("assets", "oa-app.ico"),
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID
  }
  if (!shell.writeShortcutLink(shortcutPath, "replace", details)) {
    shell.writeShortcutLink(shortcutPath, "create", details)
  }
}

function emptyAttendance(date?: Date): AttendanceState {
  const range = monthRange(date || new Date())
  return {
    state: "loading",
    message: "正在读取本月出勤",
    monthKey: range.monthKey,
    totalText: "",
    totalLabel: "加班",
    details: []
  }
}


function taskbarIconPath(): string {
  const source = resourcePath("assets", "oa-app.ico")
  const target = path.join(app.getPath("temp"), "oa-shell-window.ico")
  try {
    const sourceTime = fs.statSync(source).mtimeMs
    const targetTime = fs.existsSync(target) ? fs.statSync(target).mtimeMs : 0
    if (sourceTime > targetTime) {
      fs.copyFileSync(source, target)
    }
    return target
  } catch (error) {
    return source
  }
}

function ensureFlasher(): ReturnType<typeof createWinFlash> {
  if (!flasher) {
    flasher = createWinFlash(resourcePath("resources", "win-flash.ps1"))
  }
  return flasher
}

function noteAttention(line: string): void {
  try {
    fs.appendFileSync(path.join(app.getPath("userData"), "attention.log"), new Date().toISOString() + " " + line + "\n")
  } catch (error) {
    return
  }
}

function oaTheme(): string {
  if (!themeCss) {
    themeCss = fs.readFileSync(resourcePath("resources", "oa-theme.css"), "utf8")
  }
  return themeCss
}

function acknowledge(): void {
  attention.stopAttention()
  updateTrayMenu()
}

function syncPageFocus(focused: boolean): void {
  if (!oaView || oaView.webContents.isDestroyed()) {
    return
  }
  const script = focused ? "window.dispatchEvent(new Event('focus'))" : "window.dispatchEvent(new Event('blur'))"
  oaView.webContents.executeJavaScript(script).catch(() => {})
}

function applySubmittedOvertimeDates(state: AttendanceState): AttendanceState {
  if (!state || state.state !== "ready" || !Array.isArray(state.details)) {
    return state
  }
  const submitted = data?.submittedOvertimeDates || {}
  const details = state.details.map((item) => {
    const key = String(item.id || "")
    const hasLocalSubmission = Boolean(submitted[key]) || Boolean(data?.days?.[key]?.applied)
    if (!hasLocalSubmission) return item
    return { ...item, applied: true, applicationPeriod: submitted[key]?.period || item.applicationPeriod }
  })
  return {
    ...state,
    details,
    unappliedCount: details.filter((item) => !item.applied).length
  }
}

async function loadAttendance(): Promise<void> {
  const token = ++attendanceToken
  const range = monthRange(new Date())
  attendance = { ...attendance, state: "loading", message: "正在读取本月出勤" }
  publish()
  if (!oaView || oaView.webContents.isDestroyed()) {
    attendance = { ...emptyAttendance(), state: "error", message: "OA 还没打开" }
    publish()
    return
  }
  try {
    const result = await oaView.webContents.executeJavaScript(pageFetchExpression(range), true) as {
      statis?: unknown
      detail?: unknown
      punches?: unknown
    }
    if (token !== attendanceToken) {
      return
    }
    let next = normalizeAttendance(result && result.statis, result && result.detail, range, result && result.punches) as AttendanceState
    const unauthenticated = !next.message || next.message === "not-json" || /token/i.test(next.message);
    if (next.state === "error" && unauthenticated) {
      next.state = "login"
      next.message = "登录 OA 后才能读取本月出勤"
    } else if (next.state === "ready" && !next.totalText && next.details.length === 0) {
      next.message = "这个月还没有加班记录"
    }
    next = applySubmittedOvertimeDates(next)
    attendance = next
    lastAttendanceRefreshAt = Date.now()
  } catch (error) {
    if (token !== attendanceToken) {
      return
    }
    attendance = { ...emptyAttendance(), state: "error", message: "读取出勤失败，登录 OA 后再刷新" }
  }
  publish()
}

function maybeRefreshAttendance(minAgeMs = 20000): void {
  if (oaStatus.state !== "ready") {
    return
  }
  if (Date.now() - lastAttendanceRefreshAt < minAgeMs) {
    return
  }
  refreshAttendance().catch(() => {})
}

async function buildAssistantContext(question: string): Promise<string> {
  const lines: string[] = []
  if (attendance.state === "ready") {
    const details = attendance.details || []
    const unapplied = details.filter((item) => !item.applied)
    const unappliedCount = typeof attendance.unappliedCount === "number" ? attendance.unappliedCount : unapplied.length
    lines.push(
      `本月出勤加班（${attendance.monthKey || "当月"}）：累计 ${attendance.totalText || "0 小时"}，共 ${details.length} 条记录，其中已填申请 ${details.length - unappliedCount} 条，待核对 ${unappliedCount} 条。`
    )
    if (unapplied.length) {
      lines.push("尚未匹配到申请的加班明细：" + unapplied.slice(0, 12).map((item) => `${item.date} ${item.text}`).join("；"))
    }
  } else {
    lines.push(`本月出勤加班状态：${attendance.message || attendance.state}`)
  }
  if (/bug|issue|jira|task|todo|任务|缺陷|问题|待办|工单|需求|项目|进展|手头|名下|工作/i.test(question)) {
    const connections = integrations.list() as ConnectionConfig[]
    if (!connections.length) {
      lines.push("已接入任务系统：暂无。如需查询 Bug 或待办，请先到右上角「接入设置 → 任务系统」添加并测试连接。")
    } else {
      const settled = await Promise.allSettled(
        connections.slice(0, 4).map(async (connection) => ({
          connection,
          result: await readIntegrationTasks(connection.id)
        }))
      )
      for (let i = 0; i < settled.length; i += 1) {
        const entry = settled[i]
        const connection = connections[i]
        if (entry.status === "fulfilled") {
          const { result } = entry.value
          const preview = result.items.slice(0, 15).map((item) => {
            const meta = [item.status, item.priority, item.assignee].filter(Boolean).join("/")
            return `${item.id} · ${item.title}${meta ? ` [${meta}]` : ""}`
          })
          lines.push(
            `任务系统「${connection.name}」查询成功（总计 ${result.total ?? result.items.length} 条，本页 ${result.items.length} 条${result.hasMore ? "，还有更多" : ""}）：` +
            (preview.length ? "\n" + preview.join("\n") : "当前筛选条件下没有任务。")
          )
        } else {
          const reason = entry.reason instanceof Error ? entry.reason.message : "读取失败"
          lines.push(`任务系统「${connection.name}」读取失败：${reason}`)
        }
      }
    }
  }
  return lines.join("\n\n")
}

async function openAssistantPage(target: string): Promise<string> {
  if (!oaView || oaView.webContents.isDestroyed()) {
    return "OA 还没打开"
  }
  showWindow()
  if (target === "home") {
    await oaView.webContents.loadURL(layoutUrl())
    return "正在打开 OA 首页"
  }
  const script = "(() => { var node = document.querySelector('a[title=\"工作消息\"]'); if (node) { node.click(); return true; } return false; })()"
  try {
    const opened = await oaView.webContents.executeJavaScript(script)
    return opened ? "正在打开工作消息" : "没有找到工作消息入口"
  } catch (error) {
    return "没有打开工作消息"
  }
}

async function executeAssistantCommand(input: string): Promise<AssistantResult> {
  if (input.trim() === "/任务" || input.trim() === "查看任务") {
    const connections = integrations.list()
    if (!connections.length) return { ok: true, message: "还没有接入任务系统。点击右上角「接入设置」，添加 Jira 或内部系统。" }
    const sections: string[] = []
    for (const connection of connections) {
      try {
        const result = await readIntegrationTasks(connection.id)
        sections.push(connection.name + " · 本页 " + result.items.length + " 条" + (result.hasMore ? "（还有更多）" : "") + "\n" + result.items.slice(0, 10).map(item => item.id + " · " + item.title + (item.status ? " [" + item.status + "]" : "")).join("\n"))
      } catch (error) {
        sections.push(connection.name + "：" + (error instanceof Error ? error.message : "读取失败"))
      }
    }
    return { ok: true, message: sections.join("\n\n") + "\n\n这是只读预览，尚未领取或修改任务。" }
  }
  const parsed = parseCommand(input) as {
    ok: boolean
    name?: string
    message?: string
    target?: string
    at?: string
    text?: string
  }
  if (!parsed.ok || !parsed.name) {
    return { ok: false, message: parsed.message || "没有执行这条命令。" }
  }
  if (parsed.name === "help") {
    return { ok: true, message: helpText() + "\n/任务 查看已接入系统的任务预览；系统连接在右上角「接入设置」管理。" }
  }
  if (parsed.name === "overtime") {
    return { ok: true, message: formatOvertime(attendance) }
  }
  if (parsed.name === "refresh") {
    await refreshAttendance()
    return { ok: true, message: formatOvertime(attendance) }
  }
  if (parsed.name === "open") {
    return { ok: true, message: await openAssistantPage(parsed.target || "") }
  }
  if (parsed.name === "remind" && parsed.at && parsed.text) {
    const result = addReminder(data.tasks || [], new Date(), parsed.at, parsed.text) as {
      ok: boolean
      tasks: AssistantTask[]
      message: string
    }
    if (result.ok) {
      data.tasks = result.tasks
      persist()
    }
    return { ok: result.ok, message: result.message }
  }
  if (parsed.name === "cancel" && parsed.text) {
    const result = cancelReminder(data.tasks || [], parsed.text) as {
      ok: boolean
      tasks: AssistantTask[]
      message: string
    }
    if (result.ok) {
      data.tasks = result.tasks
      persist()
    }
    return { ok: result.ok, message: result.message }
  }
  return { ok: false, message: "没有执行这条命令。" }
}

function runAssistantTasks(): void {
  const result = collectDueReminders(data.tasks || [], new Date()) as {
    tasks: AssistantTask[]
    due: AssistantTask[]
  }
  if (!result.due.length) {
    return
  }
  data.tasks = result.tasks
  result.due.forEach((task) => {
    notify({ title: "分身提醒", body: task.text })
  })
  data = store.save(data) as unknown as AppData
  publish()
}

function refreshAttendance(): Promise<void> {
  if (attendanceTask) {
    return attendanceTask
  }
  attendanceTask = loadAttendance().finally(() => {
    attendanceTask = null
  })
  return attendanceTask
}

function openWorkMessages(): void {
  if (!oaView || oaView.webContents.isDestroyed() || openedMessages || messageOpening || messageTries > 24) {
    return
  }
  messageTries += 1
  messageOpening = true
  const script = "(() => { if (document.querySelector('.weapp-main-em:not(.im-hide) .session')) return true; var node = document.querySelector('a[title=\"工作消息\"]'); if (node) node.click(); return false; })()"
  oaView.webContents.executeJavaScript(script).then((clicked) => {
    messageOpening = false
    if (clicked) {
      openedMessages = true
      return
    }
    setTimeout(openWorkMessages, 700)
  }).catch(() => {
    messageOpening = false
    setTimeout(openWorkMessages, 700)
  })
}

function snapshot(): DeskState {
  return {
    oa: oaStatus,
    panelOpen: data.panelOpen === true,
    avatar: normalizeAvatar(data.assistantAvatar),
    attendance,
  }
}

function syncAssistantAvatar(avatar: string): void {
  if (!oaView || oaView.webContents.isDestroyed()) {
    return
  }
  const script = "window.__setAssistantAvatar && window.__setAssistantAvatar(" + JSON.stringify(avatar) + ")"
  oaView.webContents.executeJavaScript(script).catch(() => {})
}

function syncAssistantOvertimeAlert(state: AttendanceState): void {
  if (!oaView || oaView.webContents.isDestroyed()) {
    return
  }
  const count = state.state === "ready"
    ? (typeof state.unappliedCount === "number" ? state.unappliedCount : state.details.filter((item) => !item.applied).length)
    : 0
  const script = "window.__setAssistantOvertimeAlert && window.__setAssistantOvertimeAlert(" + JSON.stringify(count) + ")"
  oaView.webContents.executeJavaScript(script).catch(() => {})
}

function publish(): void {
  if (sidebarView && !sidebarView.webContents.isDestroyed()) {
    sidebarView.webContents.send("state", snapshot())
  }
  syncAssistantOvertimeAlert(attendance)
  updateTrayMenu()
}

function persist(): void {
  data = store.save(data) as unknown as AppData
  publish()
}

function isSafeWebUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === "https:" || parsed.protocol === "http:"
  } catch (error) {
    return false
  }
}

type MessagePane = { x: number; y: number; width: number; height: number }

let messagePane: MessagePane | null = null

function readMessagePane(value: unknown): MessagePane | null {
  if (!value || typeof value !== "object") {
    return null
  }
  const pane = value as Record<string, unknown>
  const x = Number(pane.x)
  const y = Number(pane.y)
  const width = Number(pane.width)
  const height = Number(pane.height)
  if (![x, y, width, height].every((item) => Number.isFinite(item))) {
    return null
  }
  if (width < 80 || height < 80 || width > 4000 || height > 4000 || x < -100 || y < -100) {
    return null
  }
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height)
  }
}

function syncAssistantPage(open: boolean): void {
  if (!oaView || oaView.webContents.isDestroyed()) {
    return
  }
  const script = "window.__setAssistantOpen && window.__setAssistantOpen(" + (open ? "true" : "false") + ")"
  oaView.webContents.executeJavaScript(script).catch(() => {})
}

function requestAssistantPane(): void {
  if (!oaView || oaView.webContents.isDestroyed()) {
    return
  }
  oaView.webContents.executeJavaScript("window.__reportAssistantPane && window.__reportAssistantPane()").catch(() => {})
}

function rememberAssistantReply(message: string): void {
  const line = String(message || "").split("\n")[0].trim().slice(0, 42)
  if (!line || !oaView || oaView.webContents.isDestroyed()) {
    return
  }
  const script = "window.__setAssistantPreview && window.__setAssistantPreview(" + JSON.stringify(line) + ")"
  oaView.webContents.executeJavaScript(script).catch(() => {})
}

function layout(): void {
  if (!mainWindow || !oaView) {
    return
  }
  const contentBounds = mainWindow.getContentBounds()
  const width = contentBounds.width
  const height = contentBounds.height
  oaView.setBounds({ x: 0, y: 0, width, height })
  const pane = data.panelOpen ? messagePane : null
  if (pane && pane.x < width && pane.y < height) {
    const x = Math.max(0, Math.min(pane.x, width - 1))
    const y = Math.max(0, Math.min(pane.y, height - 1))
    const paneWidth = Math.max(0, Math.min(pane.width, width - x))
    const paneHeight = Math.max(0, Math.min(pane.height, height - y))
    if (paneWidth >= 80 && paneHeight >= 80) {
      const view = ensureSidebarView(mainWindow)
      view.setBounds({ x, y, width: paneWidth, height: paneHeight })
      view.setVisible(true)
      return
    }
  }
  sidebarView?.setVisible(false)
  sidebarView?.setBounds({ x: 0, y: 0, width: 0, height: 0 })
}

function showWindow(): void {
  if (!mainWindow) {
    return
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

function attendanceSummary(): string {
  return attendance.totalText
    ? attendance.monthKey + " 加班 " + attendance.totalText
    : attendance.message || "本月加班"
}

function updateTrayMenu(): void {
  if (!tray) {
    return
  }
  const summary = attendanceSummary()
  tray.setToolTip(attention.isUnread() ? "OA · 有新消息，点击查看" : "OA · " + summary)
  const key = summary + "|" + String(data.panelOpen)
  if (key === trayMenuKey) {
    return
  }
  trayMenuKey = key
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: summary, enabled: false },
    { label: "显示消息", click: showWindow },
    { label: data.panelOpen ? "关闭分身" : "打开分身", click: togglePanel },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ]))
}

function notify(reminder: { title: string; body: string }): void {
  if (!Notification.isSupported()) {
    return
  }
  const notice = new Notification({
    title: reminder.title,
    body: reminder.body,
    icon: resourcePath("assets", "icon.png")
  })
  notice.on("click", showWindow)
  notice.show()
}

function setAssistantOpen(open: boolean): void {
  const changed = data.panelOpen !== open
  data.panelOpen = open
  trayMenuKey = ""
  if (open) {
    if (sidebarIdleTimer) clearTimeout(sidebarIdleTimer)
    sidebarIdleTimer = null
    showWindow()
    openWorkMessages()
    if (changed) {
      refreshAttendance().catch(() => {})
    }
    requestAssistantPane()
    setTimeout(requestAssistantPane, 500)
    setTimeout(requestAssistantPane, 1400)
  }
  layout()
  if (!open && changed) scheduleSidebarReclaim()
  if (changed) {
    persist()
  }
  syncAssistantPage(open)
}

function togglePanel(): void {
  setAssistantOpen(!data.panelOpen)
}

function rememberBounds(bounds: Rectangle): void {
  data.window = bounds
  data = store.save(data) as unknown as AppData
}

function saveBounds(): void {
  if (!mainWindow || !boundsSaver) {
    return
  }
  boundsSaver.submit(mainWindow.getBounds())
}

function hostOf(contents: WebContents): string {
  try {
    return new URL(contents.getURL()).hostname
  } catch (error) {
    return ""
  }
}

function ensureSidebarView(hostWindow: BaseWindow): WebContentsView {
  if (sidebarView) return sidebarView
  sidebarView = new WebContentsView({
    webPreferences: {
      preload: preloadPath("index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  hostWindow.contentView.addChildView(sidebarView)
  sidebarView.webContents.on("will-navigate", (event) => event.preventDefault())
  const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : ""
  if (devUrl) {
    sidebarView.webContents.loadURL(devUrl)
  } else {
    sidebarView.webContents.loadFile(rendererHtml())
  }
  return sidebarView
}

function releaseSidebarView(view: WebContentsView): void {
  sidebarView = null
  mainWindow?.contentView.removeChildView(view)
  if (!view.webContents.isDestroyed()) view.webContents.close({ waitForBeforeUnload: false })
}

function scheduleSidebarReclaim(): void {
  const view = sidebarView
  if (!view || sidebarIdleTimer) return
  const timer = setTimeout(async () => {
    const session: unknown = await view.webContents
      .executeJavaScript("window.__captureAssistantSession?.()")
      .catch(() => null)
    if (sidebarIdleTimer !== timer) return
    sidebarIdleTimer = null
    if (quitting || data.panelOpen || sidebarView !== view) return
    if (!view.webContents.isDestroyed() && (typeof session !== "string" || session.length > 1_000_000)) {
      scheduleSidebarReclaim()
      return
    }
    sidebarSession = typeof session === "string" ? session : null
    releaseSidebarView(view)
  }, SIDEBAR_IDLE_MS)
  sidebarIdleTimer = timer
}

function createViews(): void {
  const oaSession = session.fromPartition("persist:oa")
  const clientAgent = withPcClient(oaSession.getUserAgent())
  oaSession.setUserAgent(clientAgent)
  oaSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const allowed = new Set(["notifications", "media", "clipboard-read", "clipboard-sanitized-write", "fullscreen"])
    const host = hostOf(webContents) || hostFrom(details)
    callback(host === "oa.yarward.com" && allowed.has(permission))
  })
  oaView = new WebContentsView({ webPreferences: oaWebPreferences() })
  mainWindow?.contentView.addChildView(oaView)
  const popupRegistry = createPopupRegistry()
  oaView.webContents.on("did-create-window", (popup, details) => {
    oaPopups.add(popup.webContents)
    popupRegistry.register(details.url, popup)
    popup.webContents.once("did-finish-load", () => {
      if (oaView && !oaView.webContents.isDestroyed()) {
        oaView.webContents.send("oa:image-preview-ready")
      }
    })
  })
  oaView.webContents.setWindowOpenHandler(({ url }) => {
    if (!isSafeWebUrl(url)) {
      return { action: "deny" }
    }
    try {
      const parsed = new URL(url)
      if (parsed.pathname.indexOf("/sp/em/photoview") !== -1) {
        const win = ensurePhotoViewWindow()
        if (win.webContents.getURL() !== url) {
          photoViewLoaded = false
          win.loadURL(url).catch(() => {})
        }
        if (win.isMinimized()) {
          win.restore()
        }
        win.show()
        win.focus()
        if (oaView && !oaView.webContents.isDestroyed()) {
          oaView.webContents.send("oa:image-preview-ready")
        }
        return { action: "deny" }
      }
    } catch (error) {
      // Fall through to standard popup handling
    }
    if (!popupRegistry.request(url)) {
      return { action: "deny" }
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
    }
  })
  oaView.webContents.on("will-navigate", (event, url) => {
    if (!isSafeWebUrl(url)) {
      event.preventDefault()
    }
  })
  oaView.webContents.on("did-start-loading", () => {
    oaStatus = { state: "loading", message: "正在打开 OA" }
    publish()
  })
  oaView.webContents.on("dom-ready", () => {
    oaView?.webContents.insertCSS(oaTheme()).catch(() => {})
    syncAssistantPage(data.panelOpen)
    syncAssistantAvatar(normalizeAvatar(data.assistantAvatar))
    syncAssistantOvertimeAlert(attendance)
  })
  oaView.webContents.on("did-finish-load", () => {
    oaStatus = { state: "ready", message: "OA 已打开" }
    publish()
    openWorkMessages()
    setTimeout(() => refreshAttendance().catch(() => {}), 1500)
    setTimeout(() => {
      if (oaStatus.state === "ready" && attendance.state !== "ready") {
        refreshAttendance().catch(() => {})
      }
    }, 8000)
    if (mainWindow && !mainWindow.isFocused()) {
      syncPageFocus(false)
    }
  })
  oaView.webContents.setUserAgent(clientAgent)
  oaView.webContents.loadURL(layoutUrl())
}

function hostFrom(details: { requestingUrl?: string } | undefined): string {
  try {
    return new URL(details?.requestingUrl || "").hostname
  } catch (error) {
    return ""
  }
}

function createWindow(): void {
  const bounds = data.window || { width: 1440, height: 900 }
  mainWindow = new BaseWindow({
    width: bounds.width || 1440,
    height: bounds.height || 900,
    x: Number.isInteger(bounds.x) && Number(bounds.x) >= 0 && Number(bounds.x) < 2400 ? bounds.x : undefined,
    y: Number.isInteger(bounds.y) && Number(bounds.y) >= 0 && Number(bounds.y) < 1400 ? bounds.y : undefined,
    minWidth: 1100,
    minHeight: 700,
    title: "OA",
    backgroundColor: "#ffffff",
    autoHideMenuBar: true,
    icon: resourcePath("assets", "icon.png")
  })
  createViews()
  layout()
  mainWindow.on("resize", () => {
    layout()
    saveBounds()
  })
  mainWindow.on("move", saveBounds)
  mainWindow.on("focus", () => {
    popupController.dismiss()
    attention.refreshForeground().then((foreground) => {
      if (!foreground) {
        syncPageFocus(false)
        return
      }
      acknowledge()
      syncPageFocus(true)
      maybeRefreshAttendance(20000)
    }).catch(() => {})
  })
  mainWindow.on("blur", () => {
    attention.markBackground()
    syncPageFocus(false)
  })
  mainWindow.on("minimize", () => syncPageFocus(false))
  mainWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
      syncPageFocus(false)
    }
  })
}

const oaPopups = new WeakSet<WebContents>()

function registerIpc(): void {
  const connectionHandler = (channel: string, handler: (input: any) => unknown) => {
    ipcMain.handle(channel, async (event, input: unknown) => {
      if (event.sender !== sidebarView?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("此页面无权操作接入设置")
      return handler(input)
    })
  }
  connectionHandler("connections:list", () => integrations.list())
  connectionHandler("ai:config", () => aiStore.get())
  connectionHandler("ai:save", async (input) => {
    const previous = aiStore.get()
    const saved = await aiStore.save(input)
    if (previous.baseUrl !== saved.baseUrl || previous.provider !== saved.provider) {
      cachedAIModels = []
    }
    return saved
  })
  connectionHandler("ai:models", async (input) => {
    const models = await aiService.models(input)
    cachedAIModels = models
    return models
  })
  connectionHandler("ai:models-cached", () => cachedAIModels)
  connectionHandler("ai:test-chat", () => {
    if (sandboxRunner.isRunning()) throw new Error("隔离示例正在运行，请等待或停止后再试")
    return aiService.testChat("default")
  })
  connectionHandler("ai:probe", () => {
    if (sandboxRunner.isRunning()) throw new Error("隔离示例正在运行，请等待或停止后再试")
    return aiService.probe()
  })
  connectionHandler("ai:ask", async (input) => {
    if (sandboxRunner.isRunning()) throw new Error("隔离示例正在运行，请等待或停止后再试")
    const text = input && typeof input.text === "string" ? input.text : ""
    const context = await buildAssistantContext(text)
    return aiService.ask({ ...(input && typeof input === "object" ? input : {}), context })
  })
  connectionHandler("ai:cancel", () => {
    const generation = aiService.cancel()
    const sandbox = sandboxRunner.cancel()
    return generation || sandbox
  })
  connectionHandler("ai:choose-codex", async () => {
    const result = await dialog.showOpenDialog({ title: "选择 Codex 原生可执行文件", properties: ["openFile"], filters: [{ name: "Executable", extensions: process.platform === "win32" ? ["exe"] : ["*"] }] })
    return result.canceled ? null : result.filePaths[0] || null
  })
  connectionHandler("ai:sandbox", async () => {
    if (aiService.isRunning()) throw new Error("已有 AI 请求正在执行")
    return sandboxRunner.run(aiStore.get())
  })
  connectionHandler("ai:history", () => {
    const file = path.join(app.getPath("userData"), "ai-requests.jsonl")
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).slice(-30).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    }).reverse()
  })
  connectionHandler("connections:save", input => integrations.save(input))
  connectionHandler("connections:remove", async input => {
    const id = String(input)
    if (!integrations.list().some((item: ConnectionConfig) => item.id === id)) throw new Error("接入不存在")
    integrationLogins.get(id)?.close()
    await session.fromPartition("persist:integration-" + id).clearStorageData()
    return integrations.remove(id)
  })
  connectionHandler("connections:preview", input => readIntegrationTasks(String(input)))
  connectionHandler("connections:login", async input => {
    const config = integrations.list().find((item: ConnectionConfig) => item.id === String(input))
    if (!config || config.auth !== "browser") throw new Error("请选择已保存的浏览器登录接入")
    const existing = integrationLogins.get(config.id)
    if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return true }
    const partSession = session.fromPartition("persist:integration-" + config.id)
    const cleanUa = cleanBrowserUserAgent(partSession.getUserAgent())
    if (cleanUa) {
      partSession.setUserAgent(cleanUa)
    }
    const login = new BrowserWindow({
      width: 1000,
      height: 760,
      backgroundColor: "#f8fafc",
      title: config.name + " · 登录",
      autoHideMenuBar: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        partition: "persist:integration-" + config.id
      }
    })
    if (cleanUa) {
      login.webContents.setUserAgent(cleanUa)
    }
    integrationLogins.set(config.id, login)
    login.webContents.setWindowOpenHandler(({ url }) => {
      if (isSafeWebUrl(url)) {
        login.loadURL(url).catch(() => {})
      }
      return { action: "deny" }
    })
    login.webContents.on("will-navigate", (event, url) => { if (!isSafeWebUrl(url)) event.preventDefault() })
    login.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3 || login.isDestroyed()) {
        return
      }
      const safeUrl = JSON.stringify(validatedURL || config.baseUrl)
      const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;padding:32px;background:#f8fafc;color:#1e293b"><h2>页面加载失败</h2><p>${String(errorDescription || "无法打开登录页面").replace(/[<>&]/g, "")} (${errorCode})</p><p style="color:#64748b;word-break:break-all">${String(validatedURL || config.baseUrl).replace(/[<>&]/g, "")}</p><button onclick="location.replace(${safeUrl})" style="padding:8px 16px;border-radius:6px;border:1px solid #3555c5;background:#3555c5;color:#fff;cursor:pointer">重新加载</button></body></html>`
      login.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html)).catch(() => {})
    })
    login.once("closed", () => integrationLogins.delete(config.id))
    await login.loadURL(config.baseUrl)
    return true
  })
  ipcMain.handle("state:get", () => snapshot())
  ipcMain.handle("assistant:restore-session", (event) => {
    if (event.sender !== sidebarView?.webContents || event.senderFrame !== event.sender.mainFrame) return null
    const saved = sidebarSession
    sidebarSession = null
    return saved
  })
  ipcMain.handle("panel:toggle", () => {
    togglePanel()
    if (data.panelOpen) {
      maybeRefreshAttendance(15000)
    }
    return snapshot()
  })
  ipcMain.on("oa:window-state", (event) => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
    event.returnValue = {
      focused: attention.isForeground(),
      visible: Boolean(win && win.isVisible()),
      minimized: Boolean(win && win.isMinimized())
    }
  })
  function isOaClipboardSender(event: Electron.IpcMainInvokeEvent): boolean {
    const source = event.senderFrame
    const fromChat = event.sender === oaView?.webContents || event.sender === photoViewWindow?.webContents || oaPopups.has(event.sender)
    return Boolean(fromChat && source && new URL(source.url).origin === new URL(layoutUrl()).origin)
  }
  ipcMain.handle("oa:clipboard-write-text", async (event, text: unknown) => {
    try {
      if (isOaClipboardSender(event) && typeof text === "string" && text.length > 0 && !text.includes("\0")) {
        await clipboard.writeText(text)
        const actual = await clipboard.readText()
        return actual === text || actual.replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n")
      }
    } catch {
      // The OS may refuse a write while the clipboard is in use.
    }
    return false
  })
  ipcMain.handle("oa:clipboard-write-image", async (event, data: unknown) => {
    try {
      if (!isOaClipboardSender(event) || typeof data !== "string" || data.length > 24_000_000 ||
          !/^data:image\/(?:png|jpeg);base64,/i.test(data)) return false
      const image = nativeImage.createFromDataURL(data)
      if (image.isEmpty()) return false
      const png = new Blob([new Uint8Array(image.toPNG())], { type: "image/png" })
      await clipboard.write([new ClipboardItem({ "image/png": png })])
      return await clipboard.has("image/png")
    } catch { return false }
  })
  ipcMain.handle("oa:clipboard-copy-image-at", async (event, x: unknown, y: unknown) => {
    try {
      if (!isOaClipboardSender(event) || event.senderFrame !== event.sender.mainFrame ||
          typeof x !== "number" || typeof y !== "number" ||
          !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 16000 || y > 16000) return false
      const zoom = event.sender.getZoomFactor()
      event.sender.copyImageAt(Math.round(x * zoom), Math.round(y * zoom))
      for (let attempt = 0; attempt < 8; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 35))
        if (await clipboard.has("image/png")) return true
      }
    } catch { return false }
    return false
  })
  ipcMain.on("oa:attention", () => {
    attention.attractAttention().catch(() => {})
  })
  ipcMain.on("oa:attention-stop", () => acknowledge())
  ipcMain.on("oa:photo-ipc", (event, channel: unknown, payload: unknown) => {
    const allowedSender = event.sender === oaView?.webContents || event.sender === photoViewWindow?.webContents
    if (!allowedSender || typeof channel !== "string") {
      return
    }
    if (channel === "show-photo-view") {
      showPhotoView(payload)
      return
    }
    if (channel === "photo-view-params.success") {
      clearPhotoParamsTimer()
      pendingPhotoParams = null
      return
    }
    if (channel === "close-photo-view") {
      hidePhotoView()
      return
    }
    if (channel === "photo-view-custom-download-ipc") {
      if (oaView && !oaView.webContents.isDestroyed()) {
        oaView.webContents.send("oa:bridge-ipc", "photo-view-custom-download-ipc-success", {
          win: { oliType: "main" },
          param: payload
        })
      }
      return
    }
    if (channel === "photo-view-share-message-get") {
      if (oaView && !oaView.webContents.isDestroyed()) {
        oaView.webContents.send("oa:bridge-ipc", "photo-view-share-message", payload)
      }
      return
    }
    if (channel === "photo-view-share-message-callback") {
      if (photoViewWindow && !photoViewWindow.isDestroyed()) {
        photoViewWindow.webContents.send("oa:bridge-ipc", "photo-view-share-message-callback-get", payload)
      }
    }
  })
  ipcMain.on("oa:message", (event, raw: unknown) => {
    if (!oaView || event.sender !== oaView.webContents || mainWindow?.isFocused()) {
      return
    }
    const normalized = normalizeMessagePayload(raw)
    if (!normalized) {
      return
    }
    if (popupController.show(normalized)) {
      attention.attractAttention().catch(() => {})
    }
  })
  ipcMain.on("oa:overtime-flows", (event, raw: unknown) => {
    if (!oaView || (event.sender !== oaView.webContents && !oaPopups.has(event.sender)) || !raw || typeof raw !== "object") {
      return
    }
    const frame = event.senderFrame
    if (!frame || frame !== event.sender.mainFrame || !frame.url.startsWith(layoutUrl())) return
    const payload = raw as { dates?: unknown; flowNo?: unknown; title?: unknown; period?: unknown }
    const period = typeof payload.period === "string" && /^(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}–(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}$/.test(payload.period) ? payload.period : ""
    const dates = Array.isArray(payload.dates)
      ? payload.dates.filter((item): item is string => typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item))
      : []
    if (!dates.length) {
      return
    }
    const flowNo = typeof payload.flowNo === "string" ? payload.flowNo.slice(0, 40) : ""
    const title = typeof payload.title === "string" ? payload.title.slice(0, 80) : "加班申请"
    const submitted = { ...(data.submittedOvertimeDates || {}) }
    const nowIso = new Date().toISOString()
    let changed = false
    for (const key of dates) {
      const previous = submitted[key]
      if (!previous || (flowNo && previous.flowNo !== flowNo) || (period && previous.period !== period)) {
        submitted[key] = { flowNo: flowNo || previous?.flowNo || "", title, at: nowIso, period: period || (flowNo === previous?.flowNo ? previous?.period : undefined) }
        changed = true
      }
      if (!data.days[key] || !data.days[key].applied) {
        data.days[key] = {
          checkIn: data.days[key]?.checkIn || "",
          checkOut: data.days[key]?.checkOut || "",
          applied: true,
          forceWorkday: data.days[key]?.forceWorkday ?? null
        }
        changed = true
      }
    }
    if (changed) {
      data.submittedOvertimeDates = submitted
      attendance = applySubmittedOvertimeDates(attendance)
      persist()
    }
  })
  ipcMain.on("oa:show", () => showWindow())
  ipcMain.handle("assistant:command", async (event, input: unknown) => {
    if (event.sender !== sidebarView?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("此页面无权执行分身命令")
    const command = typeof input === "string" ? input.slice(0, 80) : ""
    const result = await executeAssistantCommand(command)
    rememberAssistantReply(result.message)
    return result
  })
  ipcMain.handle("assistant:set-avatar", (event, input: unknown) => {
    if (event.sender !== sidebarView?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("此页面无权修改头像")
    data.assistantAvatar = normalizeAvatar(input)
    persist()
    syncAssistantAvatar(data.assistantAvatar)
    return snapshot()
  })
  ipcMain.handle("assistant:choose-avatar", async (event) => {
    if (event.sender !== sidebarView?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("此页面无权修改头像")
    const result = await dialog.showOpenDialog({
      title: "选择分身头像",
      properties: ["openFile"],
      filters: [{ name: "图片文件", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }]
    })
    if (result.canceled || !result.filePaths[0]) {
      return null
    }
    const image = nativeImage.createFromPath(result.filePaths[0])
    if (image.isEmpty()) {
      throw new Error("无法读取所选图片，请选择有效的 PNG/JPG/WebP 图片")
    }
    const size = image.getSize()
    const resized = size.width > 160 || size.height > 160
      ? image.resize(size.width <= size.height ? { width: 160 } : { height: 160 })
      : image
    const dataUrl = "data:image/png;base64," + resized.toPNG().toString("base64")
    const normalized = normalizeAvatar(dataUrl)
    if (normalized !== dataUrl) {
      throw new Error("图片体积过大，请选择更小的头像图片")
    }
    data.assistantAvatar = normalized
    persist()
    syncAssistantAvatar(data.assistantAvatar)
    return snapshot()
  })
  ipcMain.on("assistant:open", (event) => {
    if (event.sender !== oaView?.webContents) {
      return
    }
    setAssistantOpen(true)
  })
  ipcMain.on("assistant:close", (event) => {
    if (event.sender !== oaView?.webContents) {
      return
    }
    setAssistantOpen(false)
  })
  ipcMain.on("assistant:bounds", (event, value: unknown) => {
    if (event.sender !== oaView?.webContents) {
      return
    }
    const pane = readMessagePane(value)
    if (!pane) {
      return
    }
    if (messagePane && pane.x === messagePane.x && pane.y === messagePane.y &&
      pane.width === messagePane.width && pane.height === messagePane.height) {
      return
    }
    messagePane = pane
    if (data.panelOpen) {
      layout()
    }
  })
}

const LEGACY_PROFILE_NAME = "亚华 OA"

function legacyProfileDir(): string {
  return path.join(app.getPath("appData"), LEGACY_PROFILE_NAME)
}

function importLegacyProfileFiles(): void {
  const fromDir = legacyProfileDir()
  if (!fs.existsSync(fromDir)) {
    return
  }
  const userData = app.getPath("userData")
  for (const name of ["integrations.json", "ai-settings.json", "ai-requests.jsonl"]) {
    const from = path.join(fromDir, name)
    const to = path.join(userData, name)
    if (fs.existsSync(from) && !fs.existsSync(to)) {
      fs.copyFileSync(from, to)
    }
  }
  const sandboxFrom = path.join(fromDir, "ai-sandbox")
  const sandboxTo = path.join(userData, "ai-sandbox")
  if (fs.existsSync(sandboxFrom) && !fs.existsSync(sandboxTo)) {
    fs.cpSync(sandboxFrom, sandboxTo, { recursive: true })
  }
}

function mergeLegacyOvertime(current: AppData): AppData {
  const legacyFile = path.join(legacyProfileDir(), "overtime.json")
  if (!fs.existsSync(legacyFile)) {
    return current
  }
  const legacy = createStore(legacyFile).load() as unknown as AppData
  const submitted = { ...(current.submittedOvertimeDates || {}) }
  let changed = false
  for (const [key, value] of Object.entries(legacy.submittedOvertimeDates || {})) {
    if (!submitted[key]) {
      submitted[key] = value
      changed = true
    }
  }
  const days = { ...current.days }
  for (const [key, value] of Object.entries(legacy.days || {})) {
    if (!days[key]) {
      days[key] = value
      changed = true
    }
  }
  const reminders = { ...current.reminders }
  for (const [key, value] of Object.entries(legacy.reminders || {})) {
    if (!reminders[key]) {
      reminders[key] = value
      changed = true
    }
  }
  let tasks = current.tasks
  if (tasks.length === 0 && legacy.tasks.length > 0) {
    tasks = legacy.tasks
    changed = true
  }
  let assistantAvatar = current.assistantAvatar
  if (assistantAvatar === "preset:default" && legacy.assistantAvatar && legacy.assistantAvatar !== "preset:default") {
    assistantAvatar = legacy.assistantAvatar
    changed = true
  }
  if (!changed) {
    return current
  }
  return { ...current, submittedOvertimeDates: submitted, days, reminders, tasks, assistantAvatar }
}

function createTray(): void {
  trayIcon = nativeImage.createFromPath(resourcePath("assets", "icon.png")).resize({ width: 16, height: 16 })
  trayBlankIcon = nativeImage.createFromBitmap(Buffer.alloc(16 * 16 * 4), { width: 16, height: 16 })
  tray = new Tray(trayIcon)
  tray.on("click", showWindow)
  updateTrayMenu()
}

if (gotLock) {
  app.setName("OA")
  app.setAppUserModelId(APP_USER_MODEL_ID)
  app.whenReady().then(() => {
    const credentialCrypto = {
      async encrypt(secret: string) {
        if (!await safeStorage.isAsyncEncryptionAvailable()) throw new Error("本机安全存储暂不可用，未保存凭证")
        return safeStorage.encryptStringAsync(secret)
      },
      async decrypt(cipher: Buffer) {
        try { return (await safeStorage.decryptStringAsync(cipher)).result } catch { throw new Error("凭证无法解密，请在原系统重新填写凭证") }
      }
    }
    importLegacyProfileFiles()
    integrations = createIntegrationStore(path.join(app.getPath("userData"), "integrations.json"), credentialCrypto)
    aiStore = createAIStore(path.join(app.getPath("userData"), "ai-settings.json"), credentialCrypto)
    aiService = createAIService(aiStore, (url, options) => session.fromPartition("ai-gateway").fetch(String(url), options), entry => {
      const file = path.join(app.getPath("userData"), "ai-requests.jsonl")
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) fs.renameSync(file, file + ".1")
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 })
    })
    sandboxRunner = createCodexRunner(path.join(app.getPath("userData"), "ai-sandbox"))
    store = createStore(path.join(app.getPath("userData"), "overtime.json"))
    data = store.save(mergeLegacyOvertime(store.load() as unknown as AppData)) as unknown as AppData
    data.panelOpen = false
    boundsSaver = createBoundsSaver(rememberBounds, 400)
    ensureWindowsToastIdentity()
    registerIpc()
    createWindow()
    createTray()
    attention.refreshForeground().catch(() => {})
    foregroundTimer = setInterval(() => {
      attention.refreshForeground().catch(() => {})
    }, 500)
    runAssistantTasks()
    assistantTimer = setInterval(() => {
      runAssistantTasks()
    }, 15000)
  })
  app.on("second-instance", showWindow)
  app.on("before-quit", () => {
    aiService?.cancel()
    sandboxRunner?.cancel()
    quitting = true
    if (sidebarIdleTimer) clearTimeout(sidebarIdleTimer)
    sidebarIdleTimer = null
    if (sidebarView) releaseSidebarView(sidebarView)
    boundsSaver?.flush()
    attention.stopAttention()
    popupController.dismiss()
    if (messagePopupWindow && !messagePopupWindow.isDestroyed()) {
      messagePopupWindow.destroy()
      messagePopupWindow = null
    }
    clearPhotoParamsTimer()
    if (photoViewWindow && !photoViewWindow.isDestroyed()) {
      photoViewWindow.destroy()
      photoViewWindow = null
    }
    if (foregroundTimer) {
      clearInterval(foregroundTimer)
    }
    if (assistantTimer) {
      clearInterval(assistantTimer)
    }
    if (flasher) {
      flasher.close()
    }
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit()
    }
  })
}
