const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const {
  collectPreferenceKeys,
  parseDownloadPreferences,
  parseDownloadPayload,
  resolveDownloadDir,
  resolveExplicitSavePath,
  sanitizePathSegment,
  uniqueFilePath
} = require("../src/oa-download");

test("download preferences default every key to 0", () => {
  assert.deepEqual(parseDownloadPreferences([["fileSaveType", "fileSepAccount", "fileSepSession"]]), {
    fileSaveType: 0,
    fileSepAccount: 0,
    fileSepSession: 0
  });
  assert.deepEqual(parseDownloadPreferences({ datas: ["fileSaveType"] }), {
    fileSaveType: 0,
    fileSepAccount: 0,
    fileSepSession: 0
  });
  assert.deepEqual(parseDownloadPreferences(null), {
    fileSaveType: 0,
    fileSepAccount: 0,
    fileSepSession: 0
  });
  assert.deepEqual(collectPreferenceKeys([["fileSaveType"], "fileSepSession"]), ["fileSaveType", "fileSepSession"]);
});

test("download payload rejects non-URLs and keeps the save options", () => {
  assert.equal(parseDownloadPayload(null), null);
  assert.equal(parseDownloadPayload("https://example.com/f"), null);
  assert.equal(parseDownloadPayload({ url: "ftp://example.com/f" }), null);
  assert.equal(parseDownloadPayload({ url: "https://oa.example.com/api/file/1" }).id, "");
  const payload = parseDownloadPayload({
    url: "https://oa.example.com/api/file/remotedownload/123/im/true",
    id: "msg-1",
    fid: "123",
    isSaveAs: true,
    openOnFinish: true,
    savePath: "",
    saveIsDefault: false,
    saveIsDept: true,
    saveClassifyStorage: 2,
    fileSepAccount: 0,
    fileSepSession: 1,
    sessionName: "韩帅",
    department: "软件部",
    userName: "张三"
  });
  assert.equal(payload.isSaveAs, true);
  assert.equal(payload.openOnFinish, true);
  assert.equal(payload.saveIsDept, true);
  assert.equal(payload.saveClassifyStorage, 2);
  assert.equal(payload.department, "软件部");
});

test("path segments are sanitized for Windows", () => {
  assert.equal(sanitizePathSegment("软件部"), "软件部");
  assert.equal(sanitizePathSegment("研发:中心/一组"), "研发中心一组");
  assert.equal(sanitizePathSegment("  名字...  "), "名字");
  assert.equal(sanitizePathSegment("a?b*c<d>e|f\"g"), "abcdefg");
  assert.equal(sanitizePathSegment(""), "");
});

test("download dir is Downloads by default, classified when prefs say so", () => {
  const downloads = path.join(os.tmpdir(), "Downloads");
  const base = { url: "https://x", id: "1", isSaveAs: false, openOnFinish: false, savePath: "", saveIsDefault: true, saveIsDept: false, saveClassifyStorage: 0, fileSepAccount: 0, fileSepSession: 0, sessionName: "", subCompany: "", department: "", userName: "" };
  assert.equal(resolveDownloadDir(path, downloads, base), downloads);
  assert.equal(
    resolveDownloadDir(path, downloads, { ...base, saveIsDept: true, department: "软件部" }),
    path.join(downloads, "软件部")
  );
  assert.equal(
    resolveDownloadDir(path, downloads, { ...base, saveIsDept: true, department: "软件部", fileSepSession: 1, sessionName: "韩帅" }),
    path.join(downloads, "软件部", "韩帅")
  );
  assert.equal(
    resolveDownloadDir(path, downloads, { ...base, fileSepAccount: 1, userName: "张三" }),
    path.join(downloads, "张三")
  );
  // A hostile department name cannot escape the Downloads folder.
  assert.equal(
    resolveDownloadDir(path, downloads, { ...base, saveIsDept: true, department: "..\\..\\Windows" }),
    path.join(downloads, "Windows")
  );
});

test("explicit save paths: directory joins the file name, full paths pass through", () => {
  const dir = path.join(os.tmpdir(), "Downloads");
  assert.equal(resolveExplicitSavePath(path, "", dir, "a.md"), null);
  assert.equal(resolveExplicitSavePath(path, dir + path.sep, dir, "a.md"), path.join(dir, "a.md"));
  assert.equal(resolveExplicitSavePath(path, dir, dir, "a.md"), path.join(dir, "a.md"));
  assert.equal(resolveExplicitSavePath(path, path.join(dir, "b.md"), dir, "a.md"), path.join(dir, "b.md"));
});

test("unique file paths do not overwrite an existing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-download-"));
  try {
    assert.equal(uniqueFilePath(path, dir, "a.md", fs.existsSync), path.join(dir, "a.md"));
    fs.writeFileSync(path.join(dir, "a.md"), "x");
    assert.equal(uniqueFilePath(path, dir, "a.md", fs.existsSync), path.join(dir, "a (1).md"));
    fs.writeFileSync(path.join(dir, "a (1).md"), "x");
    assert.equal(uniqueFilePath(path, dir, "a.md", fs.existsSync), path.join(dir, "a (2).md"));
    fs.writeFileSync(path.join(dir, "a.md"), "x");
    assert.equal(uniqueFilePath(path, dir, "noext", fs.existsSync), path.join(dir, "noext"));
    fs.writeFileSync(path.join(dir, "noext"), "x");
    assert.equal(uniqueFilePath(path, dir, "noext", fs.existsSync), path.join(dir, "noext (1)"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- bridge forwarding: the download channels must reach the real ipcRenderer ---

function loadBridgeWithRecordingIpc() {
  const calls = { send: [], invoke: [], sendSync: [] };
  const fakeIpcRenderer = {
    send(channel, payload) { calls.send.push([channel, payload]); },
    invoke(channel, payload) { calls.invoke.push([channel, payload]); return Promise.resolve({ fileSaveType: 0 }); },
    sendSync(channel, payload) { calls.sendSync.push([channel, payload]); return ""; },
    on() {},
    removeAllListeners() {}
  };
  const target = new EventTarget();
  const window = {
    localStorage: { getItem: () => null, setItem: () => {} },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target)
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../src/oa-bridge"), "utf8"), {
    window,
    require: () => ({ ipcRenderer: fakeIpcRenderer }),
    setInterval() {}
  });
  return { electron: window.emRequire("electron"), calls };
}

test("bridge forwards download-file to the main process", () => {
  const { electron, calls } = loadBridgeWithRecordingIpc();
  const payload = { url: "https://oa.example.com/api/file/1", id: "msg-1", isSaveAs: false };
  electron.ipcRenderer.send("download-file", payload);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0][0], "download-file");
  assert.equal(calls.send[0][1], payload);
});

test("bridge forwards get-preferences through invoke instead of resolving null", async () => {
  const { electron, calls } = loadBridgeWithRecordingIpc();
  const result = await electron.ipcRenderer.invoke("get-preferences", [["fileSaveType"]]);
  assert.equal(calls.invoke.length, 1);
  assert.equal(calls.invoke[0][0], "get-preferences");
  assert.deepEqual(result, { fileSaveType: 0 });
});

test("bridge still drops unrelated channels", () => {
  const { electron, calls } = loadBridgeWithRecordingIpc();
  electron.ipcRenderer.send("some-random-channel", { x: 1 });
  electron.ipcRenderer.sendSync("some-random-channel", { x: 1 });
  assert.equal(calls.send.length, 0);
  assert.equal(calls.sendSync.length, 0);
});

test("explicit save paths let the filesystem decide dotted directories and extensionless files", () => {
  const dir = path.join(os.tmpdir(), "Downloads");
  const statPath = (candidate) => {
    if (candidate.endsWith("backup.2026")) return "dir";
    if (candidate.endsWith("README")) return "file";
    return null;
  };
  assert.equal(
    resolveExplicitSavePath(path, path.join(dir, "backup.2026"), dir, "a.md", statPath),
    path.join(dir, "backup.2026", "a.md")
  );
  assert.equal(
    resolveExplicitSavePath(path, path.join(dir, "README"), dir, "a.md", statPath),
    path.join(dir, "README")
  );
  // A relative path lands under Downloads, not the process working directory.
  assert.equal(resolveExplicitSavePath(path, "sub/a.md", dir, "x.md"), path.join(dir, "sub", "a.md"));
  // A path that does not exist yet keeps the old dot heuristic.
  assert.equal(resolveExplicitSavePath(path, path.join(dir, "backup.2026"), dir, "a.md"), path.join(dir, "backup.2026"));
});

test("sanitizePathSegment never splits an emoji and rejects reserved device names", () => {
  assert.equal(sanitizePathSegment("CON"), "_CON");
  assert.equal(sanitizePathSegment("com1"), "_com1");
  assert.equal(sanitizePathSegment("NUL.txt"), "_NUL.txt");
  assert.equal(sanitizePathSegment("a".repeat(79) + "😀b"), "a".repeat(79) + "😀");
  const cut = sanitizePathSegment("a".repeat(80) + "😀");
  assert.equal(cut, "a".repeat(80));
  assert.ok(!/[\uD800-\uDFFF]/.test(cut));
});
