const fs = require("fs");
const path = require("path");
const { normalizeData } = require("./overtime");

function createStore(filePath) {
  function preserveCorrupt() {
    // A damaged data file must never be overwritten by the next save:
    // move it aside so the data can still be recovered by hand.
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
        const suffix = Date.now() + "-" + Math.floor(Math.random() * 10000);
        fs.renameSync(filePath, filePath + ".corrupt-" + suffix);
      }
    } catch (error) {
      // Keep going with defaults; losing the backup is better than crashing.
    }
  }

  function load() {
    try {
      return normalizeData(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (error) {
      preserveCorrupt();
      // Fall back to the last good backup, if it still reads.
      try {
        return normalizeData(JSON.parse(fs.readFileSync(filePath + ".bak", "utf8")));
      } catch (error2) {
        return normalizeData({});
      }
    }
  }

  function save(data) {
    const normalized = normalizeData(data);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    // A stale .tmp is garbage from a crashed earlier save; drop it first.
    try { fs.rmSync(temporaryPath, { force: true }); } catch (error) {}
    // Keep the last good file as a backup before replacing it. Only a
    // file that still parses counts as good: never let a damaged file
    // overwrite the backup.
    try {
      if (fs.existsSync(filePath)) {
        JSON.parse(fs.readFileSync(filePath, "utf8"));
        fs.copyFileSync(filePath, filePath + ".bak");
      }
    } catch (error) {}
    fs.writeFileSync(temporaryPath, JSON.stringify(normalized, null, 2), "utf8");
    try {
      const fd = fs.openSync(temporaryPath, "r");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } catch (error) {}
    // Rename directly over the old file: it is atomic on the same volume,
    // so a crash can never leave the user with no data file at all.
    // (Deleting first, as before, lost everything if the app died in between.)
    // integrations.js and ai-gateway.js already save this way on Windows.
    fs.renameSync(temporaryPath, filePath);
    // The rename itself must also reach the disk: fsync the directory
    // so an OS/power loss cannot roll the rename back. Best effort
    // only: opening a directory for fsync is not available everywhere.
    try {
      const dirFd = fs.openSync(path.dirname(filePath), "r");
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch (error) {}
    return normalized;
  }

  return { load, save };
}

module.exports = { createStore };
