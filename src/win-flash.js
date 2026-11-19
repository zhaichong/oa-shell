const { spawn } = require("child_process");

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
      seenReady = true;
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
      child.stdin.write(line + "\n");
    }));
    chain = run.then(() => {}, () => {});
    return run;
  }

  return {
    foreground() {
      return ask("FG");
    },
    flash(hwnd) {
      return ask("FLASH " + hwnd);
    },
    stop(hwnd) {
      return ask("STOP " + hwnd);
    },
    setIcon(hwnd, iconPath) {
      const icon = iconPath && iconPath !== "0" ? String(iconPath) : "0";
      return ask("ICON " + hwnd + " " + icon);
    },
    close() {
      if (child) {
        child.kill();
        child = null;
      }
    }
  };
}

module.exports = { createWinFlash };
