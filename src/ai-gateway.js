const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function defaults() {
  return { enabled: false, provider: "magpie", baseUrl: "http://127.0.0.1:3425/v1", protocol: "chat", auth: "bearer", allowHttp: false, defaultModel: "", analysisModel: "", codingModel: "", reviewModel: "", executorPath: "", timeoutSeconds: 120, outputLimit: 4096, metadataRetries: 1 };
}

function isLoopback(url) {
  return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
}

function normalizeAIConfig(input) {
  if (!input || typeof input !== "object") throw new Error("AI 配置无效");
  const config = { ...defaults() };
  if (!["magpie", "compatible"].includes(input.provider || config.provider)) throw new Error("AI 提供方无效");
  config.provider = input.provider || config.provider;
  let url;
  try { url = new URL(input.baseUrl || config.baseUrl); } catch { throw new Error("网关地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("网关地址不能包含凭证、查询参数或片段");
  if (url.protocol === "http:" && !isLoopback(url) && input.allowHttp !== true) throw new Error("远程 HTTP 需要明确允许明文连接");
  config.baseUrl = url.href.replace(/\/$/, "").replace(/\/(?:chat\/completions|responses|models)$/i, "");
  config.allowHttp = input.allowHttp === true;
  config.enabled = input.enabled === true;
  config.protocol = input.protocol || "chat";
  config.auth = input.auth || "bearer";
  config.executorPath = typeof input.executorPath === "string" ? input.executorPath.trim().slice(0, 2000) : "";
  if (!["chat", "responses"].includes(config.protocol) || !["none", "bearer"].includes(config.auth)) throw new Error("协议或认证方式无效");
  for (const key of ["defaultModel", "analysisModel", "codingModel", "reviewModel"]) {
    const value = typeof input[key] === "string" ? input[key].trim() : "";
    if (value.length > 180 || /[\s\x00-\x1f]/.test(value)) throw new Error("模型 ID 无效");
    config[key] = value;
  }
  if (config.enabled && !config.defaultModel) throw new Error("启用 AI 前请选择默认模型");
  for (const [key, minimum, maximum] of [["timeoutSeconds", 5, 300], ["outputLimit", 128, 16384], ["metadataRetries", 0, 2]]) {
    if (input[key] !== undefined) {
      const value = Number(input[key]);
      if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(key + " 超出允许范围");
      config[key] = value;
    }
  }
  return config;
}

function createAIStore(filePath, crypto) {
  let queue = Promise.resolve();
  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (saved.version !== 1) throw new Error("version");
      return { config: normalizeAIConfig(saved.config), encryptedKey: saved.encryptedKey || "" };
    } catch (error) {
      if (error.code === "ENOENT") return { config: defaults(), encryptedKey: "" };
      throw new Error("AI 配置文件读取失败，未覆盖原文件");
    }
  }
  function localKey(config) {
    return config.provider === "magpie" && isLoopback(new URL(config.baseUrl)) ? "magpie-oa-shell" : "";
  }
  return {
    get() {
      const saved = read();
      return { ...saved.config, keyConfigured: Boolean(saved.encryptedKey) };
    },
    save(input) {
      const operation = queue.then(async () => {
        const config = normalizeAIConfig(input);
        const previous = read();
        let encryptedKey = previous.encryptedKey;
        if (["baseUrl", "auth", "provider"].some(key => config[key] !== previous.config[key]) || input.clearApiKey === true || config.auth === "none") encryptedKey = "";
        const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
        if (apiKey.length > 8000 || /[\x00-\x1f\x7f]/.test(apiKey)) throw new Error("AI 凭证长度或格式无效");
        if (apiKey && config.auth === "bearer") encryptedKey = (await crypto.encrypt(apiKey)).toString("base64");
        if (config.auth === "bearer" && !encryptedKey && !localKey(config)) throw new Error("请填写网关凭证；修改地址后不能复用原凭证");
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath + ".tmp", JSON.stringify({ version: 1, config, encryptedKey }, null, 2), { mode: 0o600 });
        fs.renameSync(filePath + ".tmp", filePath);
        return { ...config, keyConfigured: Boolean(encryptedKey) };
      });
      queue = operation.catch(() => {});
      return operation;
    },
    async resolve() {
      const saved = read();
      const apiKey = saved.config.auth === "none" ? "" : saved.encryptedKey ? await crypto.decrypt(Buffer.from(saved.encryptedKey, "base64")) : localKey(saved.config);
      if (saved.config.auth === "bearer" && !apiKey) throw new Error("请先配置 AI 网关凭证");
      return { config: saved.config, apiKey };
    }
  };
}

function selectModel(config, stage) {
  if (!["default", "analysis", "coding", "code", "review"].includes(stage)) throw new Error("AI 任务阶段无效");
  const key = stage === "analysis" ? "analysisModel" : ["coding", "code"].includes(stage) ? "codingModel" : stage === "review" ? "reviewModel" : "defaultModel";
  const model = config[key] || config.defaultModel;
  if (!model) throw new Error("请先在 AI 模型设置中选择默认模型");
  return model;
}

async function readJson(response) {
  if (response.status >= 300 && response.status < 400) throw new Error("网关发生重定向，请直接填写真实接口地址");
  if (!response.ok) {
    const error = new Error("AI 网关请求失败，HTTP " + response.status + (response.status === 429 ? "（额度或频率受限）" : ""));
    error.status = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  if (!response.body) throw new Error("AI 网关返回空响应");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error("AI 响应超过 4MB 限制"); }
    chunks.push(Buffer.from(value));
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("网关没有返回 JSON，请检查地址与协议"); }
}

function parseReply(payload, protocol) {
  const usage = payload.usage || {};
  const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
  const model = typeof payload.model === "string" && !payload.model.startsWith("group/") ? payload.model.slice(0, 180) : "unknown";
  let text = "";
  if (protocol === "chat") {
    const content = payload.choices && payload.choices[0] && payload.choices[0].message && payload.choices[0].message.content;
    text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(item => item && (item.type === "text" || item.type === "output_text")).map(item => item.text || "").join("") : "";
  } else {
    text = typeof payload.output_text === "string" ? payload.output_text : (payload.output || []).flatMap(item => item.content || []).filter(item => item && item.type === "output_text").map(item => item.text || "").join("");
  }
  return { text: text.slice(0, 100000), model, inputTokens: integer(usage.input_tokens ?? usage.prompt_tokens), outputTokens: integer(usage.output_tokens ?? usage.completion_tokens) };
}

function createAIService(store, fetcher = fetch, audit = entry => {}) {
  let active = null;
  async function request(config, apiKey, route, body, controller, sessionId) {
    const headers = { Accept: "application/json", "Content-Type": "application/json", "X-Magpie-Session": sessionId, "User-Agent": "oa-shell/0.1" };
    if (apiKey) headers.Authorization = "Bearer " + apiKey;
    try {
      const response = await fetcher(config.baseUrl + route, { method: body ? "POST" : "GET", headers, body: body ? JSON.stringify(body) : undefined, redirect: "manual", credentials: "omit", signal: controller.signal });
      return await readJson(response);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("AI 请求已停止或超时");
      if (error instanceof TypeError) { const failure = new Error("无法连接 AI 网关，请检查 Magpie、地址和网络"); failure.retryable = true; throw failure; }
      throw error;
    }
  }
  async function inference(config, apiKey, body, run) {
    const started = Date.now();
    const requestedModel = body.model;
    const entry = { id: randomUUID(), sessionId: run.id, at: new Date().toISOString(), stage: run.stage, requestedModel, model: "unknown", status: "failed", durationMs: 0, inputTokens: null, outputTokens: null };
    try {
      const payload = await request(config, apiKey, config.protocol === "chat" ? "/chat/completions" : "/responses", body, run.controller, run.id);
      const reply = parseReply(payload, config.protocol);
      Object.assign(entry, reply, { status: "success" });
      delete entry.text;
      return { payload, reply: { ...reply, requestedModel, requestId: entry.id } };
    } finally {
      entry.durationMs = Date.now() - started;
      try { await audit(entry); } catch {}
    }
  }
  async function execute(stage, action) {
    if (active) throw new Error("已有 AI 请求正在执行，请等待或停止当前请求");
    const run = { id: randomUUID(), stage, controller: new AbortController() };
    active = run;
    let timer;
    try {
      const { config, apiKey } = await store.resolve();
      if (!config.enabled) throw new Error("AI 尚未启用，请到接入设置 → AI 模型配置并启用");
      timer = setTimeout(() => run.controller.abort(), config.timeoutSeconds * 1000);
      return await action(config, apiKey, run);
    } finally {
      if (timer) clearTimeout(timer);
      if (active === run) active = null;
    }
  }
  function bodyFor(config, model, text) {
    const message = { role: "user", content: text };
    return config.protocol === "chat" ? { model, messages: [message], max_tokens: config.outputLimit, stream: false } : { model, input: [message], max_output_tokens: config.outputLimit, stream: false };
  }
  return {
    async models(override) {
      let config;
      let apiKey;
      if (override && typeof override === "object") {
        config = normalizeAIConfig({ ...override, enabled: false, defaultModel: "", analysisModel: "", codingModel: "", reviewModel: "" });
        const draftKey = typeof override.apiKey === "string" ? override.apiKey : "";
        if (draftKey.length > 8000 || /[\x00-\x1f\x7f]/.test(draftKey)) throw new Error("AI 凭证长度或格式无效");
        if (config.auth === "none") {
          apiKey = "";
        } else if (draftKey) {
          apiKey = draftKey;
        } else {
          const saved = await store.resolve().catch(() => null);
          const sameBinding = saved && ["baseUrl", "auth", "provider"].every(key => config[key] === saved.config[key]);
          if (sameBinding && saved.apiKey) {
            apiKey = saved.apiKey;
          } else if (config.provider === "magpie" && isLoopback(new URL(config.baseUrl))) {
            apiKey = "magpie-oa-shell";
          } else {
            throw new Error("请填写网关 Key 后再检测");
          }
        }
      } else {
        ({ config, apiKey } = await store.resolve());
      }
      let last;
      for (let attempt = 0; attempt <= config.metadataRetries; attempt += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.min(config.timeoutSeconds, 15) * 1000);
        try {
          const payload = await request(config, apiKey, "/models", null, controller, randomUUID());
          const rawList = Array.isArray(payload) ? payload : Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : null;
          if (!rawList) throw new Error("模型目录格式无效，应包含 data 或 models 数组");
          const seen = new Set();
          return rawList.slice(0, 3000).filter(item => item && typeof item.id === "string" && item.id.length <= 180 && !/[\s\x00-\x1f]/.test(item.id) && !seen.has(item.id) && seen.add(item.id)).map(item => ({ id: item.id, name: String(item.display_name || item.name || item.id).slice(0, 180), provider: String(item.owned_by || item.provider || item.id.split("/")[0]).slice(0, 80) }));
        } catch (error) {
          last = error;
          if (!error.retryable) throw error;
        } finally { clearTimeout(timer); }
      }
      throw last;
    },
    async ask(input) {
      if (!input || typeof input.text !== "string" || !input.text.trim() || input.text.length > 16000) throw new Error("请输入不超过 16000 字的内容");
      return execute(input.stage || "analysis", async (config, apiKey, run) => {
        const model = selectModel(config, run.stage);
        const body = bodyFor(config, model, input.text.trim());
        const extraContext = typeof input.context === "string" && input.context.trim() ? input.context.trim().slice(0, 12000) : "";
        const history = Array.isArray(input.history)
          ? input.history
              .filter(item => item && (item.role === "user" || item.role === "assistant") && typeof item.text === "string" && item.text.trim())
              .slice(-8)
              .map(item => ({ role: item.role, content: item.text.trim().slice(0, 4000) }))
          : [];
        if (history.length) {
          if (config.protocol === "chat") body.messages = [...history, ...body.messages];
          else body.input = [...history, ...body.input];
        }
        const basePrompt = extraContext
          ? "你是 OA 分身。当前你可以参考下方附带的只读考勤加班和任务系统查询结果回答问题（均为只读快照，不得声称已经领取任务、修改文件、提交代码或运行测试）。回答务必以实际数据与用户明确内容为准；如某系统未接入或读取报错，如实告知。\n\n" + extraContext
          : "你是 OA 分身。此入口只做问答、需求分析和建议，没有执行代码或访问任务系统的工具。不得声称已经领取任务、修改文件、提交代码或运行测试。只根据用户明确提供的内容回答；缺少信息时说明。";
        const system = { role: "system", content: basePrompt };
        if (config.protocol === "chat") body.messages.unshift(system);
        else body.instructions = system.content;
        const { reply } = await inference(config, apiKey, body, run);
        if (!reply.text.trim()) throw new Error("模型未返回可显示内容，请调整输出上限或模型后重试");
        return reply;
      });
    },
    testChat(stage = "default") {
      return execute(stage, async (config, apiKey, run) => {
        const model = selectModel(config, stage);
        const body = bodyFor(config, model, "请仅回复 OK，不要输出多余说明。");
        const { reply } = await inference(config, apiKey, body, run);
        if (!reply.text.trim()) throw new Error("模型未返回文本，请检查模型配置或输出上限");
        return { ...reply, text: "对话连通验证成功。" };
      });
    },
    probe(stage = "coding") {
      return execute(stage, async (config, apiKey, run) => {
        const model = selectModel(config, stage);
        const makeProbeBody = (strict) => {
          const body = bodyFor(config, model, "Call report_probe exactly once with status ok. This is a read-only connection test.");
          const definition = { name: "report_probe", description: "Report a read-only connectivity test result", ...(strict ? { strict: true } : {}), parameters: { type: "object", properties: { status: { type: "string", enum: ["ok"] } }, required: ["status"], additionalProperties: false } };
          body.tools = config.protocol === "chat" ? [{ type: "function", function: definition }] : [{ type: "function", ...definition }];
          body.tool_choice = config.protocol === "chat" ? { type: "function", function: { name: "report_probe" } } : { type: "function", name: "report_probe" };
          return body;
        };
        let body = makeProbeBody(true);
        let first;
        try {
          first = await inference(config, apiKey, body, run);
        } catch (error) {
          if (error.status !== 400 && error.status !== 422) throw error;
          body = makeProbeBody(false);
          first = await inference(config, apiKey, body, run);
        }
        const message = first.payload.choices && first.payload.choices[0] && first.payload.choices[0].message;
        const calls = config.protocol === "chat" ? message && message.tool_calls : (first.payload.output || []).filter(item => item && item.type === "function_call");
        if (!Array.isArray(calls) || calls.length !== 1) throw new Error("模型未返回单次工具调用，不能确认工具兼容性");
        const call = calls[0];
        const definitionCall = config.protocol === "chat" ? call.function : call;
        let args;
        try {
          args = typeof definitionCall.arguments === "string" ? JSON.parse(definitionCall.arguments) : definitionCall.arguments;
        } catch {
          throw new Error("模型返回的工具参数不是有效 JSON");
        }
        if (definitionCall.name !== "report_probe" || !args || args.status !== "ok" || Object.keys(args).length !== 1 || !(config.protocol === "chat" ? call.id : call.call_id)) throw new Error("模型返回的工具名称或参数不匹配");
        const followup = bodyFor(config, model, "");
        if (config.protocol === "chat") followup.messages = [...body.messages, message, { role: "tool", tool_call_id: call.id, content: '{"ok":true}' }];
        else followup.input = [...body.input, ...(first.payload.output || []), { type: "function_call_output", call_id: call.call_id, output: '{"ok":true}' }];
        const second = await inference(config, apiKey, followup, run);
        if (!second.reply.text.trim()) throw new Error("工具结果回传后模型未返回文本，兼容性测试未完成");
        return { ...second.reply, text: "工具调用与结果回传验证成功。" };
      });
    },
    cancel() {
      if (!active) return false;
      active.controller.abort();
      return true;
    },
    isRunning: () => active !== null
  };
}

module.exports = { normalizeAIConfig, createAIStore, createAIService, selectModel };
