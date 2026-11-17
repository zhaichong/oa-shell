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
    fs.rmSync(filePath, { force: true });
    fs.renameSync(temporaryPath, filePath);
    return normalized;
  }

  return { load, save };
}

module.exports = { createStore };
