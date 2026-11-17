const { spawn } = require("child_process");
const path = require("path");

function createWinFlash() {
  let child = null;
  let buffer = "";
  let pending = [];
  let seenReady = false;
  let chain = Promise.resolve();

  function onLine(line) {
    if (!seenReady) {
      seenReady = true;
      return;
    }
    const waiter = pending.shift();
    if (waiter) {
      waiter(line);
    }
  }

  function start() {
    if (child) {
      return;
    }
    child = spawn("powershell.exe", [
      "-NoProfile",
      "-NoLogo",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(__dirname, "win-flash.ps1")
    ], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
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
      child = null;
      seenReady = false;
      pending.splice(0).forEach((waiter) => waiter(""));
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
      const timer = setTimeout(() => {
        const index = pending.indexOf(finish);
        if (index >= 0) {
          pending.splice(index, 1);
        }
        finish("timeout");
      }, 4000);
      pending.push((value) => {
        clearTimeout(timer);
        finish(value);
      });
      if (!child || !child.stdin.writable) {
        clearTimeout(timer);
        finish("");
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
    close() {
      if (child) {
        child.kill();
        child = null;
      }
    }
  };
}

module.exports = { createWinFlash };
