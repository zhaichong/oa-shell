function createPopupRegistry() {
  const windows = new Map();
  const pending = new Map();
  return {
    request(url) {
      const existing = windows.get(url);
      if (existing && !existing.isDestroyed()) {
        if (existing.isMinimized()) {
          existing.restore();
        }
        existing.show();
        existing.focus();
        return false;
      }
      if ((pending.get(url) || 0) > Date.now()) {
        return false;
      }
      pending.set(url, Date.now() + 10000);
      return true;
    },
    register(url, popup) {
      pending.delete(url);
      // A slow first creation can leave a second window for the same
      // URL: the newer registration wins and the orphaned window is
      // closed instead of lingering unreachably.
      const previous = windows.get(url);
      if (previous && previous !== popup && !previous.isDestroyed()) {
        previous.close();
      }
      windows.set(url, popup);
      if (popup.webContents && typeof popup.webContents.on === "function") {
        // A popup that navigates keeps its window but changes content:
        // re-key the registry to its current URL, or a request for the
        // original URL would focus the wrong page and a request for the
        // new URL would open a second copy.
        popup.webContents.on("did-navigate", (event, nextUrl) => {
          if (!nextUrl || windows.get(nextUrl) === popup) {
            return;
          }
          const owner = windows.get(nextUrl);
          if (owner && owner !== popup && !owner.isDestroyed()) {
            // Another live popup already owns this URL: do not steal
            // its registration, or that window becomes unreachable.
            return;
          }
          for (const [key, value] of windows) {
            if (value === popup) {
              windows.delete(key);
            }
          }
          windows.set(nextUrl, popup);
        });
      }
      popup.once("closed", () => {
        for (const [key, value] of windows) {
          if (value === popup) {
            windows.delete(key);
          }
        }
      });
    }
  };
}

module.exports = { createPopupRegistry };
