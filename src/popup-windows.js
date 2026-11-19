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
      windows.set(url, popup);
      popup.once("closed", () => {
        if (windows.get(url) === popup) {
          windows.delete(url);
        }
      });
    }
  };
}

module.exports = { createPopupRegistry };
