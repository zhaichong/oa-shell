const fs = require("fs");
const buf = fs.readFileSync("C:/Program Files (x86)/Weaver/EMobile10/resources/app.asar");
const headerStringSize = buf.readUInt32LE(12);
const header = JSON.parse(buf.toString("utf8", 16, 16 + headerStringSize));
function find(node, name, prefix) {
  if (!node.files) return null;
  for (const key of Object.keys(node.files)) {
    const child = node.files[key];
    const next = prefix ? prefix + "/" + key : key;
    if (key === name) return { path: next, node: child };
    const found = find(child, name, next);
    if (found) return found;
  }
  return null;
}
const file = find(header, "webview-preload.js", "");
console.log(JSON.stringify({ path: file.path, size: file.node.size, offset: file.node.offset }));
const dataOffset = 16 + headerStringSize + Number(file.node.offset);
const content = buf.slice(dataOffset, dataOffset + file.node.size).toString("utf8");
fs.writeFileSync("E:/杂七杂八/oa-shell/.tmp-preload.js", content);
console.log(content.slice(0, 1500));
