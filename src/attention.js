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

/**
 * @param {object} options
 * @param {() => any} options.getWindow
 * @param {() => any} options.getTray
 * @param {() => any} options.getIcons
 * @param {{ foreground: () => Promise<any>, flash: (hwnd: string) => Promise<any>, stop: (hwnd: string) => Promise<any>, setIcon?: (hwnd: string, iconPath: string) => Promise<any> }} options.flasher
 * @param {(line: string) => void} [options.note]
 * @param {(fn: () => void, delay: number) => any} [options.schedule]
 * @param {(id: any) => void} [options.cancel]
 */
function createAttention({
  getWindow,
  getTray,
  getIcons,
  flasher,
  note = () => {},
  schedule = setInterval,
  cancel = clearInterval
}) {
  let hasUnread = false;
  let trayBlinkTimer = null;
  let taskbarBlinkTimer = null;
  let attentionToken = 0;
  let weAreForeground = false;

  function icons() {
    return getIcons() || {};
  }

  function setUnreadIndicator(unread) {
    hasUnread = unread;
    const tray = getTray();
    const current = icons();
    if (!unread && trayBlinkTimer) {
      cancel(trayBlinkTimer);
      trayBlinkTimer = null;
    }
    if (tray && current.normal) {
      const hiddenIcon = current.blank || current.normal;
      if (!trayBlinkTimer) {
        tray.setImage(unread ? hiddenIcon : current.normal);
      }
      if (unread && !trayBlinkTimer) {
        let showIcon = false;
        trayBlinkTimer = schedule(() => {
          if (!hasUnread || !getTray()) {
            return;
          }
          showIcon = !showIcon;
          const latest = icons();
          getTray().setImage(showIcon ? latest.normal : (latest.blank || latest.normal));
        }, 500);
      }
      tray.setToolTip(unread ? "亚华 OA · 有新消息，点击查看" : "亚华 OA");
    }
  }

  function paintTaskbarIcon(blank) {
    const win = getWindow();
    const hwnd = hwndOf(win);
    const iconPath = icons().windowIcon;
    if (!hwnd || !iconPath || typeof flasher.setIcon !== "function") {
      return;
    }
    flasher.setIcon(hwnd, blank ? "0" : iconPath).catch(() => {});
  }

  function startTaskbarBlink(token) {
    if (taskbarBlinkTimer) {
      cancel(taskbarBlinkTimer);
      taskbarBlinkTimer = null;
    }
    let blank = true;
    const paint = () => {
      if (token !== attentionToken || !hasUnread) {
        return;
      }
      paintTaskbarIcon(blank);
      blank = !blank;
    };
    paint();
    taskbarBlinkTimer = schedule(paint, 500);
  }

  function restoreTaskbarIcon() {
    if (taskbarBlinkTimer) {
      cancel(taskbarBlinkTimer);
      taskbarBlinkTimer = null;
    }
    paintTaskbarIcon(false);
  }

  function stopWindowFlash() {
    const win = getWindow();
    const hwnd = hwndOf(win);
    if (hwnd) {
      Promise.resolve(flasher.stop(hwnd)).catch(() => {});
    }
    if (win && !win.isDestroyed() && typeof win.flashFrame === "function") {
      win.flashFrame(false);
    }
  }

  function stopAttention() {
    attentionToken += 1;
    setUnreadIndicator(false);
    restoreTaskbarIcon();
    stopWindowFlash();
  }

  function flashTaskbar() {
    const win = getWindow();
    if (!win || win.isDestroyed() || typeof win.flashFrame !== "function" || weAreForeground) {
      return;
    }
    win.flashFrame(true);
  }

  function onTaskbar(win) {
    return Boolean(win && !win.isDestroyed() && (win.isVisible() || win.isMinimized()));
  }

  async function refreshForeground() {
    const win = getWindow();
    const hwnd = hwndOf(win);
    if (!hwnd || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized()) {
      weAreForeground = false;
      return false;
    }
    const foreground = await flasher.foreground();
    weAreForeground = foreground === hwnd;
    return weAreForeground;
  }

  async function attractAttention() {
    const token = ++attentionToken;
    const foreground = await refreshForeground();
    if (token !== attentionToken || foreground) {
      return;
    }
    setUnreadIndicator(true);
    const win = getWindow();
    // A hidden window has no taskbar button. Keep it hidden and use the tray notification.
    if (!onTaskbar(win)) {
      return;
    }
    startTaskbarBlink(token);
    const hwnd = hwndOf(win);
    if (!hwnd) {
      flashTaskbar();
      note("flash missing-hwnd");
      return;
    }
    try {
      const result = await flasher.flash(hwnd);
      note("flash " + hwnd + " " + result + " foreground=" + weAreForeground);
      if (token === attentionToken && (!result || String(result).indexOf("ok") !== 0)) {
        flashTaskbar();
      }
    } catch (error) {
      note("flash failed");
      if (token === attentionToken) {
        flashTaskbar();
      }
    }
  }

  return {
    attractAttention,
    stopAttention,
    refreshForeground,
    markBackground() {
      weAreForeground = false;
    },
    isForeground() {
      return weAreForeground;
    },
    isUnread() {
      return hasUnread;
    }
  };
}

module.exports = { createAttention, hwndOf };
