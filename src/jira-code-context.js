const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execute = promisify(execFile);
const MAX_FILES = 6;
const MAX_CONTEXT = 10000;

const SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|css|scss|less|html?|py|go|rs|java|kt|cs|cpp|c|hpp|h|rb|php|swift|dart|sql|sh|ps1|md)$/i;
const EXCLUDED = /^(?:node_modules|vendor|dist|build|out|target|coverage|\.next|\.nuxt|\.cache)$/i;
const SECRET = /^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|credentials(?:[._-]|$)|secrets?(?:[._-]|$)|id_(?:rsa|ed25519))/i;
const KEY_FILE = /\.(?:pem|pfx|p12|key)$/i;

function isReadableSource(content) {
  return !content.includes("\0") && !content.includes("\uFFFD") && !content.startsWith("version https://git-lfs.github.com/spec/");
}

function sensitivePath(filename) {
  return filename.split("/").some(part => SECRET.test(part)) || KEY_FILE.test(filename);
}

async function openBaseline(repository, branch, pinnedCommit) {
  if (typeof repository !== "string" || !path.isAbsolute(repository) || /[\0\r\n]/.test(repository) ||
      typeof branch !== "string" || !branch.trim() || branch.length > 200 || /[\0\r\n]/.test(branch)) {
    throw new Error("请选择本地 Git 仓库和基准分支。");
  }
  if (pinnedCommit !== undefined && (typeof pinnedCommit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(pinnedCommit))) {
    throw new Error("查找时的 Git 提交无效，请重新查找。");
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const git = (args, maxBuffer = 48 * 1024) => execute("git", ["--no-replace-objects", "--literal-pathspecs", ...args], {
    cwd: repository, env: { ...env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" },
    windowsHide: true, timeout: 8000, maxBuffer
  });
  let commit;
  try {
    const revision = (pinnedCommit || branch).trim();
    commit = (await git(["rev-parse", "--verify", "--end-of-options", revision + "^{commit}"])).stdout.trim();
  } catch {
    throw new Error(pinnedCommit ? "查找时的提交无法读取，请重新查找。" : "无法读取 Git 基准分支，请检查仓库、分支和 Git 安装。");
  }
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit) || (pinnedCommit && pinnedCommit !== commit)) {
    throw new Error("Git 基准提交无效。");
  }
  return { git, commit };
}

async function readJiraCodeContext({ repository, branch, files, commit: pinnedCommit }) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) throw new Error("请选择 1–6 个源文件。");
  const filenames = [...new Set(files.map(file => {
    if (typeof file !== "string") throw new Error("文件路径无效。");
    const filename = file.trim().replace(/\\/g, "/");
    const parts = filename.split("/");
    if (filename.length > 300 || /[:\x00-\x1f]/.test(filename) ||
        parts.some(part => !part || part === "." || part === ".." || /^\.git$/i.test(part))) {
      throw new Error("文件必须使用相对于仓库根目录的路径。");
    }
    if (sensitivePath(filename)) throw new Error("不能发送凭证或密钥文件。");
    return filename;
  }))];
  const { git, commit } = await openBaseline(repository, branch, pinnedCommit);
  const sources = [];
  for (const filename of filenames) {
    let content;
    try {
      const tree = (await git(["ls-tree", "--full-tree", "-z", commit, "--", filename])).stdout;
      const blob = /^100(?:644|755) blob ([a-f0-9]{40,64})\t[^\0]+\0$/.exec(tree);
      if (!blob) throw new Error("Not a tracked regular file");
      const size = Number((await git(["cat-file", "-s", blob[1]])).stdout.trim());
      if (!Number.isSafeInteger(size) || size > MAX_CONTEXT * 4) throw new Error("Too large");
      content = (await git(["cat-file", "blob", blob[1]])).stdout;
      if (!isReadableSource(content)) {
        throw new Error("Not UTF-8 source");
      }
    } catch {
      throw new Error("基准提交中的文件不可读取、不是普通文本或过大：" + filename);
    }
    sources.push({ path: filename, content });
    if (JSON.stringify(sources).length > MAX_CONTEXT) throw new Error("所选代码超过分析上限，请减少文件或选择更小的文件。");
  }
  return { branch: branch.trim(), commit, sources };
}

function issueTerms(title, description) {
  const issue = (title + "\n" + description).slice(0, 7000).replace(/\\/g, "/").toLowerCase();
  const words = new Set();
  const raw = title + "\n" + description;
  for (const token of raw.match(/[\w$.-]+/g) || []) {
    if (/^[a-z][\w$-]{2,47}$/i.test(token) && !/^(?:error|failed|failure|exception|null|undefined|true|false|the|and|main|src|test|http|https|for|from|with|when|function|return)$/i.test(token)) {
      words.add(token.toLowerCase());
    }
  }
  const segments = new Intl.Segmenter("zh-CN", { granularity: "word" }).segment(raw.slice(0, 3000));
  for (const { segment } of segments) {
    if (/^\p{Script=Han}{2,8}$/u.test(segment) && !/^(?:问题|缺陷|异常|失败|页面|点击|显示|用户|系统|无法|复现|步骤|标题|描述|实际|预期|功能|测试|出现|处理|需要|进行|没有)$/.test(segment)) words.add(segment);
  }
  return { issue, words: [...words].slice(0, 24) };
}

async function findJiraCodeCandidates({ repository, branch, title = "", description = "" }) {
  const { git, commit } = await openBaseline(repository, branch);
  const { issue, words } = issueTerms(title, description);
  let tree;
  try {
    tree = (await git(["ls-tree", "-rlz", "--full-tree", commit], 4 * 1024 * 1024)).stdout;
  } catch {
    throw new Error("无法在时限内读取基准提交的文件列表，请手动补充文件。");
  }
  const candidates = [];
  const seen = new Set();
  const eligible = new Map();
  for (const entry of tree.split("\0")) {
    const file = /^100(?:644|755) blob ([a-f0-9]+)\s+(\d+)\t(.+)$/.exec(entry);
    if (!file) continue;
    const filename = file[3];
    if (filename.length > 300 || /[:\x00-\x1f\uFFFD]/.test(filename) || !SOURCE.test(filename) || sensitivePath(filename) ||
        filename.split("/").some(part => EXCLUDED.test(part)) || /\.min\.[a-z]+$/i.test(filename) ||
        Number(file[2]) > MAX_CONTEXT * 4) continue;
    eligible.set(filename, { size: Number(file[2]), blob: file[1] });
    const full = filename.toLowerCase();
    const base = path.posix.basename(full);
    const stem = base.replace(/\.[^.]+$/, "");
    if (full.includes("/") && issue.includes(full)) {
      candidates.push({ path: filename, reason: "工单提到文件路径", score: 3 });
    } else if (issue.includes(base) || words.includes(stem)) {
      candidates.push({ path: filename, reason: "匹配文件名或组件名", score: 2 });
    } else continue;
    seen.add(filename);
  }
  if (candidates.length < 12 && words.length) {
    const paths = [...eligible.keys()].filter(filename => !seen.has(filename)).slice(0, 2400);
    const patterns = words.flatMap(word => ["-e", word]);
    const deadline = Date.now() + 8000;
    for (let offset = 0; offset < paths.length && candidates.length < 12 && Date.now() < deadline;) {
      const batch = [];
      let length = 0;
      while (offset + batch.length < paths.length && batch.length < 240) {
        const filename = paths[offset + batch.length];
        if (length + filename.length + 3 > 12000) break;
        length += filename.length + 3;
        batch.push(filename);
      }
      if (!batch.length) break;
      offset += batch.length;
      try {
        const { stdout } = await git(["grep", "-ilzF", "--no-textconv", "-I", ...patterns, commit, "--", ...batch], 192 * 1024);
        for (const entry of stdout.split("\0")) {
          const filename = entry.startsWith(commit + ":") ? entry.slice(commit.length + 1) : "";
          if (eligible.has(filename) && !seen.has(filename)) {
            candidates.push({ path: filename, reason: "源码包含工单关键词", score: 1 });
            seen.add(filename);
          }
        }
      } catch (error) {
        if (error.code !== 1) break;
      }
    }
  }
  const results = [];
  let recommended = 0;
  let bytes = 0;
  candidates.sort((left, right) => right.score - left.score || left.path.localeCompare(right.path));
  for (const { path: filename, reason, score } of candidates.slice(0, 24)) {
    const { size, blob } = eligible.get(filename);
    try {
      if (!isReadableSource((await git(["cat-file", "blob", blob])).stdout)) continue;
    } catch { continue; }
    const selected = score >= 2 && recommended < 3 && bytes + size <= 8000;
    if (selected) {
      recommended += 1;
      bytes += size;
    }
    results.push({ path: filename, reason, selected });
    if (results.length === 12) break;
  }
  return { commit, candidates: results };
}

module.exports = { findJiraCodeCandidates, readJiraCodeContext };
