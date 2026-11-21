const { spawn } = require("child_process");

function isHwnd(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0;
  return typeof value === "string" && /^\d+$/.test(value);
}

function createWinFlash(scriptPath, options = {}) {
  if (!scriptPath) {
    throw new Error("WinFlash script path is required");
  }
  const spawnImpl = options.spawn || spawn;
  const timeoutMs = options.timeoutMs || 4000;
  let child = null;
  let buffer = "";
  const pending = [];
  let seenReady = false;
  let chain = Promise.resolve();

  function settle(waiter, value) {
    if (!waiter || waiter.settled) {
      return;
    }
    waiter.settled = true;
    clearTimeout(waiter.timer);
    const index = pending.indexOf(waiter);
    if (index >= 0) {
      pending.splice(index, 1);
    }
    waiter.finish(value);
  }

  function onLine(line) {
    if (!seenReady) {
      // Only the literal "ready" line marks the helper ready. A warning
      // printed first must not be swallowed as "ready", or the real
      // "ready" would be delivered to the first command as its reply.
      if (line === "ready") {
        seenReady = true;
      }
      return;
    }
    settle(pending[0], line);
  }

  function start() {
    if (child) {
      return;
    }
    child = spawnImpl("powershell.exe", [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      scriptPath
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"]
    });
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let index = buffer.indexOf("\n");
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) {
          onLine(line);
        }
        index = buffer.indexOf("\n");
      }
    });
    child.on("exit", () => {
      const abandoned = pending.splice(0);
      child = null;
      seenReady = false;
      // A partial line left in the buffer belongs to the dead helper:
      // without this reset it is prepended to the next helper's first
      // line ("ok 12ready" never equals "ready") and every later ask()
      // is swallowed until its timeout.
      buffer = "";
      abandoned.forEach((waiter) => settle(waiter, ""));
    });
    // A spawn failure ("error") is not an "exit": without this listener
    // Node throws it as an uncaught exception and can kill the main process.
    child.on("error", () => {
      const abandoned = pending.splice(0);
      child = null;
      seenReady = false;
      buffer = "";
      abandoned.forEach((waiter) => settle(waiter, ""));
    });
  }

  function ask(line) {
    const run = chain.then(() => new Promise((resolve) => {
      start();
      let settled = false;
      const finish = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(value);
      };
      const waiter = { settled: false, finish, timer: null };
      waiter.timer = setTimeout(() => settle(waiter, "timeout"), timeoutMs);
      pending.push(waiter);
      if (!child || !child.stdin || !child.stdin.writable) {
        settle(waiter, "");
        return;
      }
      try {
        child.stdin.write(line + "\n");
      } catch (error) {
        // The child died between the writable check and the write (EPIPE):
        // settle with "" like any other failed request instead of rejecting.
        settle(waiter, "");
      }
    }));
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    foreground() {
      return ask("FG");
    },
    flash(hwnd) {
      // A malformed handle must never reach the helper: its [Int64]
      // cast would kill the whole script. (The script also guards the
      // cast now, but bad input should not be sent at all.)
      if (!isHwnd(hwnd)) return Promise.resolve("");
      return ask("FLASH " + hwnd);
    },
    stop(hwnd) {
      if (!isHwnd(hwnd)) return Promise.resolve("");
      return ask("STOP " + hwnd);
    },
    setIcon(hwnd, iconPath) {
      if (!isHwnd(hwnd)) return Promise.resolve("");
      const icon = iconPath && iconPath !== "0" ? String(iconPath) : "0";
      return ask("ICON " + hwnd + " " + icon);
    },
    close() {
      if (child) {
        // Settle first (same as "exit"): otherwise a request in flight
        // hangs until its timeout even though the helper is gone.
        const abandoned = pending.splice(0);
        abandoned.forEach((waiter) => settle(waiter, ""));
        child.kill();
        child = null;
        seenReady = false;
        buffer = "";
      }
    }
  };
}

module.exports = { createWinFlash };
