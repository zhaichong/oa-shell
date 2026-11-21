// Pure helpers for the OA chat-file download bridge.
//
// The OA page downloads a chat file by asking the main process:
//   ipcRenderer.invoke("get-preferences", [[keys]])  -> download prefs
//   ipcRenderer.send("download-file", payload)       -> start a download
// The main process then runs the real Electron download and reports back
// through "download-progress" / "download-completed" / "download-error" /
// "download-cancelled", which the OA page already listens for.
//
// These helpers normalize and validate that traffic. They take no Electron
// imports so the main handlers stay thin and the logic is unit-testable.

const KNOWN_PREFERENCE_KEYS = ["fileSaveType", "fileSepAccount", "fileSepSession"];
const DEFAULT_PREFERENCE_VALUE = 0;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toSafeNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toSafeString(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function toSafeBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

// Collect the requested preference keys out of the invoke payload. OA sends
// [["fileSaveType","fileSepAccount","fileSepSession"]] (an array holding
// the keys array); a flat array or an object with a `datas` array is
// accepted too.
function collectPreferenceKeys(input) {
  const keys = [];
  const visit = (value) => {
    if (typeof value === "string") {
      if (!keys.includes(value)) keys.push(value);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (isPlainObject(value)) {
      if (Array.isArray(value.datas)) value.datas.forEach(visit);
      Object.keys(value).forEach((key) => {
        if (KNOWN_PREFERENCE_KEYS.includes(key)) keys.push(key);
      });
    }
  };
  visit(input);
  return keys;
}

// The download preferences the original client kept in its settings store.
// oa-shell never stored them, so every key defaults to 0: save to the
// default location, no per-account / per-session folders. The shape matches
// what the OA page reads (E.fileSaveType / E.fileSepAccount /
// E.fileSepSession).
function parseDownloadPreferences(input) {
  const out = {};
  for (const key of KNOWN_PREFERENCE_KEYS) {
    out[key] = DEFAULT_PREFERENCE_VALUE;
  }
  const requested = collectPreferenceKeys(input);
  for (const key of requested) {
    if (KNOWN_PREFERENCE_KEYS.includes(key) && out[key] === undefined) {
      out[key] = DEFAULT_PREFERENCE_VALUE;
    }
  }
  return out;
}

function parseDownloadPayload(input) {
  if (!isPlainObject(input)) return null;
  const url = toSafeString(input.url, "");
  if (!url || url.length > 8192) return null;
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return {
    url,
    id: toSafeString(input.id, ""),
    fid: toSafeString(input.fid, ""),
    isSaveAs: toSafeBoolean(input.isSaveAs),
    openOnFinish: toSafeBoolean(input.openOnFinish),
    savePath: toSafeString(input.savePath, ""),
    saveIsDefault: toSafeBoolean(input.saveIsDefault),
    saveIsDept: toSafeBoolean(input.saveIsDept),
    saveClassifyStorage: toSafeNumber(input.saveClassifyStorage, 0),
    fileSepAccount: toSafeNumber(input.fileSepAccount, 0),
    fileSepSession: toSafeNumber(input.fileSepSession, 0),
    sessionName: toSafeString(input.sessionName, ""),
    subCompany: toSafeString(input.subCompany, ""),
    department: toSafeString(input.department, ""),
    userName: toSafeString(input.userName, "")
  };
}

// Windows refuses to create files named CON/PRN/AUX/NUL/COM1../LPT9
// (with or without an extension): such a name must never survive as a
// folder or file name, or the download fails.
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
  "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
]);

// Strip every character Windows forbids in a path segment, plus leading
// and trailing dots/spaces (Windows drops trailing ones silently, which
// would split one folder into two spellings of the same name, and a
// leading ".." must never survive as a parent-directory hop).
function sanitizePathSegment(value) {
  const cleaned = String(value || "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  // Slice on code points so an emoji is never cut in half (a lone
  // surrogate makes path creation throw on Windows).
  const sliced = Array.from(cleaned).slice(0, 80).join("");
  if (WINDOWS_RESERVED_NAMES.has(sliced.toUpperCase().split(".")[0])) {
    return "_" + sliced;
  }
  return sliced;
}

// The folder a download goes to before the file name is added:
// the Downloads folder, plus a department folder when the prefs say to
// classify by department (saveIsDept), plus a session folder when the
// prefs say to separate by session (fileSepSession === 1), plus an
// account folder when the prefs say to separate by account
// (fileSepAccount === 1). With the default prefs (all 0) this is just
// the Downloads folder.
function resolveDownloadDir(pathModule, downloadsDir, payload) {
  let dir = downloadsDir;
  if (payload.saveIsDept) {
    const dept = sanitizePathSegment(payload.department || payload.subCompany || payload.userName);
    if (dept) dir = pathModule.join(dir, dept);
  }
  if (payload.fileSepAccount === 1) {
    const account = sanitizePathSegment(payload.userName);
    if (account) dir = pathModule.join(dir, account);
  }
  if (payload.fileSepSession === 1) {
    const session = sanitizePathSegment(payload.sessionName);
    if (session) dir = pathModule.join(dir, session);
  }
  return dir;
}

// A full save path for an explicit savePath from the payload: an empty
// value means "no explicit path". A value ending in a separator (or with
// no file name in its last segment) is a directory; anything else is
// already a full file path. A relative path is anchored under dir (the
// Downloads folder), never under the main process working directory.
// When the path exists, the filesystem decides (statPath returns
// "dir"/"file"/null): a directory whose name contains a dot (e.g.
// "backup.2026") used to be mistaken for a file, and an extensionless
// file (e.g. "README") for a directory. A path that does not exist yet
// keeps the old dot heuristic.
function resolveExplicitSavePath(pathModule, savePath, dir, filename, statPath) {
  if (!savePath) return null;
  const raw = String(savePath);
  const normalized = pathModule.isAbsolute(raw) ? raw : pathModule.join(dir, raw);
  if (normalized.endsWith("/") || normalized.endsWith("\\")) {
    return pathModule.join(normalized, filename);
  }
  if (typeof statPath === "function") {
    const kind = statPath(normalized);
    if (kind === "dir") return pathModule.join(normalized, filename);
    if (kind === "file") return normalized;
  }
  const last = normalized.split(/[\\/]/).pop() || "";
  if (!last.includes(".")) {
    return pathModule.join(normalized, filename);
  }
  return normalized;
}

// A non-colliding file path inside dir: "name.ext", then "name (1).ext",
// "name (2).ext", ... `exists` is fs.existsSync (injected for tests).
function uniqueFilePath(pathModule, dir, filename, exists) {
  const safeName = String(filename || "download").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_");
  const candidate = pathModule.join(dir, safeName);
  if (!exists(candidate)) return candidate;
  const ext = pathModule.extname(safeName);
  const base = ext ? safeName.slice(0, -ext.length) : safeName;
  for (let n = 1; n < 100; n += 1) {
    const next = pathModule.join(dir, base + " (" + n + ")" + ext);
    if (!exists(next)) return next;
  }
  return pathModule.join(dir, base + " (" + Date.now() + ")" + ext);
}

module.exports = {
  KNOWN_PREFERENCE_KEYS,
  collectPreferenceKeys,
  parseDownloadPreferences,
  parseDownloadPayload,
  sanitizePathSegment,
  resolveDownloadDir,
  resolveExplicitSavePath,
  uniqueFilePath
};
