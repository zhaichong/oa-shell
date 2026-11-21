const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { selectModel } = require("./ai-gateway");

const EXPECTED_SOURCE = "module.exports = (left, right) => left + right;\n";
const EXPECTED_AGENTS = "This is an isolated regression fixture. Only edit sum.cjs. Do not read or write outside this directory. Do not use network tools. Preserve the tests.\n";
const TEST_SOURCE = 'const assert = require("node:assert/strict");\nconst sum = require("./sum.cjs");\nassert.equal(sum(2, 3), 5);\nassert.equal(sum(-1, 1), 0);\nconsole.log("Sandbox tests passed");\n';

function buildCodexArgs(config, workspace) {
  const url = new URL(config.baseUrl);
  if (config.provider !== "magpie" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("隔离示例验证当前仅支持本机 Magpie");
  return ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "--sandbox", "workspace-write", "--cd", workspace, "--json", "--color", "never", "-m", selectModel(config, "coding"),
    "-c", 'approval_policy="never"',
    "-c", 'model_provider="oa_magpie"',
    "-c", 'model_providers.oa_magpie.name="OA Magpie"',
    "-c", "model_providers.oa_magpie.base_url=" + JSON.stringify(config.baseUrl),
    "-c", 'model_providers.oa_magpie.env_key="OA_MAGPIE_KEY"',
    "-c", 'model_providers.oa_magpie.wire_api="responses"',
    "-c", "model_providers.oa_magpie.request_max_retries=0",
    "-c", "sandbox_workspace_write.network_access=false", "-"];
}

function executionEnv() {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(path|systemroot|windir|userprofile|temp|tmp|localappdata|appdata|programfiles|programfiles\(x86\)|homedrive|homepath|comspec)$/i.test(key)) environment[key] = value;
  }
  return { ...environment, OA_MAGPIE_KEY: "magpie-oa-shell" };
}

function stopChild(child, force = false) {
  if (!child || !child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  child.kill(force ? "SIGKILL" : "SIGTERM");
  if (!force) {
    // A child that ignores SIGTERM must not wedge the runner forever:
    // escalate to SIGKILL after a grace period.
    const timer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 5000);
    if (typeof timer.unref === "function") timer.unref();
  }
}

function validateFixture(workspace) {
  // A deleted file surfaces as a raw ENOENT with the full workspace
  // path: check existence first so the message stays readable.
  for (const name of ["sum.cjs", "sum.test.cjs", "AGENTS.md"]) {
    if (!fs.existsSync(path.join(workspace, name))) throw new Error("示例文件被删除/修改，验证未通过");
  }
  for (const name of ["sum.cjs", "sum.test.cjs"]) {
    const file = path.join(workspace, name);
    if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > 65536) throw new Error("示例文件类型或大小异常，未执行测试");
  }
  if (fs.readFileSync(path.join(workspace, "sum.test.cjs"), "utf8") !== TEST_SOURCE) throw new Error("示例测试被修改，验证未通过");
  if (fs.readFileSync(path.join(workspace, "sum.cjs"), "utf8").replace(/\s/g, "") !== EXPECTED_SOURCE.replace(/\s/g, "")) throw new Error("代码未按固定示例要求修复，未执行未知代码");
  if (fs.readFileSync(path.join(workspace, "AGENTS.md"), "utf8") !== EXPECTED_AGENTS) throw new Error("示例说明被修改，验证未通过");
  // Only the files the runner itself wrote may exist: anything else was
  // created by the model (exfiltration, a rewritten prompt, a new script)
  // and must fail the check instead of being silently kept.
  const allowed = new Set(["sum.cjs", "sum.test.cjs", "AGENTS.md", "executor.log"]);
  for (const name of fs.readdirSync(workspace)) {
    if (!allowed.has(name)) throw new Error("示例目录出现多余文件 " + name + "，验证未通过");
  }
}

function createCodexRunner(root) {
  let active = null;
  return {
    async run(config) {
      if (active) throw new Error("已有隔离示例正在执行");
      if (!config.enabled) throw new Error("请先启用 AI");
      if (!config.executorPath || !path.isAbsolute(config.executorPath) || !fs.existsSync(config.executorPath) || (process.platform === "win32" && !config.executorPath.toLowerCase().endsWith(".exe"))) throw new Error("请选择可用的 Codex 原生可执行文件，不使用 .cmd 或 shell 脚本");
      const id = randomUUID();
      const workspace = path.resolve(root, id);
      if (!workspace.startsWith(path.resolve(root) + path.sep)) throw new Error("示例工作目录无效");
      const args = buildCodexArgs(config, workspace);
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, "sum.cjs"), "module.exports = (left, right) => left - right;\n");
      fs.writeFileSync(path.join(workspace, "sum.test.cjs"), TEST_SOURCE);
      fs.writeFileSync(path.join(workspace, "AGENTS.md"), EXPECTED_AGENTS);
      const job = {
        child: null,
        failure: "",
        stop(reason) {
          const first = !this.failure;
          if (first) this.failure = reason;
          // Re-attempt the kill even when a failure is already set: a
          // second stop (timeout after a user cancel, or the reverse)
          // must still reach a child that ignored the first signal,
          // so it escalates straight to SIGKILL.
          stopChild(this.child, !first);
        }
      };
      active = job;
      const started = Date.now();
      const timer = setTimeout(() => job.stop("隔离示例超过配置的执行时限，已停止"), Math.min(config.timeoutSeconds * 1000, 300000));
      const record = { id, workspace, requestedModel: selectModel(config, "coding"), ok: false, message: "", durationMs: 0 };
      try {
        const result = await new Promise((resolve, reject) => {
          const child = spawn(config.executorPath, args, { cwd: workspace, env: executionEnv(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
          job.child = child;
          let text = "";
          let diagnostics = "";
          const receive = chunk => {
            const remaining = 512 * 1024 - text.length;
            const part = chunk.toString();
            text += part.slice(0, remaining);
            if (part.length > remaining) job.stop("Codex 输出超过示例日志上限，已停止");
          };
          child.stdout.on("data", receive);
          child.stderr.on("data", chunk => {
            receive(chunk);
            diagnostics += chunk.toString();
            if (/exec_command failed[^\n]*rejected: blocked by policy/i.test(diagnostics)) {
              job.stop("Codex 的命令被执行策略拦截，已停止隔离示例。");
            }
            diagnostics = diagnostics.slice(-2048);
          });
          child.on("error", () => reject(new Error("无法启动 Codex 执行器，请检查路径及运行权限")));
          child.on("close", code => resolve({ code, text: text.slice(0, 512 * 1024) }));
          child.stdin.on("error", () => {});
          child.stdin.end("Fix the bug in sum.cjs in this isolated fixture. Replace its entire contents with exactly this code: " + EXPECTED_SOURCE + "Do not change sum.test.cjs or any other files. Run node sum.test.cjs to verify. No commits, no network, no files outside this workspace.\n");
        });
        try {
          fs.writeFileSync(path.join(workspace, "executor.log"), result.text, { flag: "wx" });
        } catch (error) {
          // A pre-created executor.log is the model tampering with the
          // fixture, not a crash: say so instead of surfacing EEXIST.
          if (error && error.code === "EEXIST") throw new Error("示例文件被删除/修改，验证未通过");
          throw error;
        }
        if (job.failure) throw new Error(job.failure);
        if (result.code !== 0) throw new Error("Codex 未成功完成。日志保存在示例目录，请检查模型兼容性或系统沙箱配置");
        validateFixture(workspace);
        await new Promise((resolve, reject) => execFile(process.execPath, [path.join(workspace, "sum.test.cjs")], { cwd: workspace, env: { ...executionEnv(), ELECTRON_RUN_AS_NODE: "1" }, timeout: 10000, maxBuffer: 65536, windowsHide: true }, (error, stdout) => error ? reject(new Error("独立示例测试未通过")) : resolve(stdout)));
        if (job.failure) throw new Error(job.failure);
        record.ok = true;
        record.message = "Codex 已通过 Magpie 修复固定示例，独立测试通过。未操作真实仓库。";
      } catch (error) {
        record.message = error instanceof Error ? error.message : "隔离示例失败";
      } finally {
        clearTimeout(timer);
        record.durationMs = Date.now() - started;
        active = null;
        // Overwrite, don't fail: a model-created result.json must not
        // throw EEXIST out of this finally and lose the record.
        fs.writeFileSync(path.join(workspace, "result.json"), JSON.stringify(record, null, 2), { flag: "w" });
      }
      return record;
    },
    cancel() {
      if (!active) return false;
      active.stop("你已停止隔离示例");
      return true;
    },
    isRunning: () => active !== null
  };
}

module.exports = { buildCodexArgs, executionEnv, validateFixture, createCodexRunner };
