const fs = require("fs");
const path = require("path");
const { normalizeData } = require("./overtime");

function createStore(filePath) {
  function load() {
    try {
      return normalizeData(JSON.parse(fs.readFileSync(filePath, "utf8")));
    } catch (error) {
      return normalizeData({});
    }
  }

  function save(data) {
    const normalized = normalizeData(data);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(normalized, null, 2), "utf8");
    // Rename directly over the old file: it is atomic on the same volume,
    // so a crash can never leave the user with no data file at all.
    // (Deleting first, as before, lost everything if the app died in between.)
    // integrations.js and ai-gateway.js already save this way on Windows.
    fs.renameSync(temporaryPath, filePath);
    return normalized;
  }

  return { load, save };
}

module.exports = { createStore };
