const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeAIConfig, createAIStore, createAIService } = require("../src/ai-gateway");

function config(patch = {}) {
  return { provider: "magpie", baseUrl: "http://127.0.0.1:3425/v1", enabled: true, defaultModel: "test/coder", ...patch };
}

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oa-ai-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "ai.json");
  const store = createAIStore(file, {
    encrypt: async text => Buffer.from(text).reverse(),
    decrypt: async cipher => Buffer.from(cipher).reverse().toString()
  });
  return { store, file };
}

test("validates gateway URL, model selection and explicit remote HTTP permission", () => {
  assert.equal(normalizeAIConfig(config()).baseUrl, "http://127.0.0.1:3425/v1");
  assert.throws(() => normalizeAIConfig(config({ baseUrl: "https://user:key@example.test/v1" })), /地址/);
  assert.throws(() => normalizeAIConfig(config({ baseUrl: "http://example.test/v1" })), /HTTP/);
  assert.throws(() => normalizeAIConfig(config({ defaultModel: "" })), /默认模型/);
});

test("AI credentials are encrypted, separate, and cannot follow an edited host", async context => {
  const { store, file } = fixture(context);
  await store.save(config({ apiKey: "private-ai-key" }));
  assert.equal(JSON.stringify(store.get()).includes("private-ai-key"), false);
  assert.equal(fs.readFileSync(file, "utf8").includes("private-ai-key"), false);
  await store.save({ ...store.get(), analysisModel: "test/analysis", apiKey: "" });
  assert.equal((await store.resolve()).apiKey, "private-ai-key");
  await assert.rejects(store.save({ ...store.get(), baseUrl: "https://different.test/v1", apiKey: "" }), /凭证/);
  assert.equal((await store.resolve()).config.baseUrl, "http://127.0.0.1:3425/v1");
});

test("catalog is dynamic; analysis uses its configured model and only explicit text", async context => {
  const { store } = fixture(context);
  await store.save(config({ analysisModel: "test/analysis" }));
  let request;
  const audit = [];
  const service = createAIService(store, async (url, options) => {
    assert.equal(options.redirect, "manual");
    if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "test/analysis", display_name: "Analysis" }, { id: "group/custom" }] }));
    request = JSON.parse(options.body);
    return new Response(JSON.stringify({ model: "test/served", choices: [{ message: { content: "已分析" } }], usage: { prompt_tokens: 10, completion_tokens: 4 } }));
  }, entry => audit.push(entry));
  assert.equal((await service.models()).length, 2);
  const result = await service.ask({ text: "分析这条测试需求", stage: "analysis" });
  assert.equal(request.model, "test/analysis");
  assert.equal(request.messages.at(-1).content, "分析这条测试需求");
  assert.equal(result.text, "已分析");
  assert.equal(result.model, "test/served");
  assert.equal(JSON.stringify(audit).includes("分析这条测试需求"), false);
});

test("tool probe validates arguments and completes a read-only two-round exchange", async context => {
  const { store } = fixture(context);
  await store.save(config());
  let rounds = 0;
  const service = createAIService(store, async (_url, options) => {
    const body = JSON.parse(options.body);
    rounds += 1;
    if (rounds === 1) return new Response(JSON.stringify({ model: "test/coder", choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-1", type: "function", function: { name: "report_probe", arguments: '{"status":"ok"}' } }] } }] }));
    assert.equal(body.messages.at(-1).role, "tool");
    assert.equal(body.messages.at(-1).tool_call_id, "call-1");
    return new Response(JSON.stringify({ model: "test/coder", choices: [{ message: { content: "工具验证成功" } }] }));
  });
  const result = await service.probe();
  assert.equal(rounds, 2);
  assert.match(result.text, /成功/);
});

test("rejects redirects and does not disclose a vendor error body or retry inference", async context => {
  const { store } = fixture(context);
  await store.save(config());
  let calls = 0;
  const service = createAIService(store, async () => { calls += 1; return new Response("private error body", { status: 429 }); });
  await assert.rejects(service.ask({ text: "test" }), error => !error.message.includes("private") && /429/.test(error.message));
  assert.equal(calls, 1);
  const redirect = createAIService(store, async () => new Response("", { status: 302 }));
  await assert.rejects(redirect.models(), /重定向/);
});

test("Responses sends the tool result with the original call ID and reads output_text", async context => {
  const { store } = fixture(context);
  await store.save(config({ protocol: "responses", codingModel: "test/coding" }));
  const exchanges = [];
  const service = createAIService(store, async (url, options) => {
    assert.ok(url.endsWith("/responses"));
    const body = JSON.parse(options.body);
    exchanges.push(body);
    const output = body.tools
      ? [{ type: "function_call", name: "report_probe", call_id: "fixture", arguments: '{"status":"ok"}' }]
      : [{ type: "message", content: [{ type: "output_text", text: "OK" }] }];
    return Response.json({ model: body.model, output });
  });
  assert.equal((await service.ask({ text: "test" })).text, "OK");
  assert.equal((await service.probe()).model, "test/coding");
  assert.equal(exchanges.length, 3);
  assert.deepEqual(exchanges[2].input.at(-1), { type: "function_call_output", call_id: "fixture", output: '{"ok":true}' });
});

test("a pending AI request can be cancelled without starting a second inference", async context => {
  const { store } = fixture(context);
  await store.save(config());
  const ready = Promise.withResolvers();
  const service = createAIService(store, async (_url, options) => {
    ready.resolve();
    return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true }));
  });
  const pending = service.testChat();
  await ready.promise;
  await assert.rejects(service.testChat(), /正在执行/);
  assert.equal(service.cancel(), true);
  await assert.rejects(pending, /停止/);
  assert.equal(service.isRunning(), false);
});

test("normalizes trailing gateway routes, previews models before saving, forwards context/history, and handles flexible probes", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-shell-ai-ext-"));
  try {
    const normalized = normalizeAIConfig({
      provider: "compatible",
      baseUrl: "https://ai.example.test/v1/chat/completions",
      protocol: "chat",
      auth: "bearer",
      enabled: false
    });
    assert.equal(normalized.baseUrl, "https://ai.example.test/v1");

    const crypto = { encrypt: async value => Buffer.from(value, "utf8"), decrypt: async buf => buf.toString("utf8") };
    const store = createAIStore(path.join(tempDir, "ai.json"), crypto);

    const unsavedService = createAIService(store, async (url, init) => {
      assert.equal(url, "https://draft.example.test/v1/models");
      assert.equal(init.headers.Authorization, "Bearer draft-secret");
      return new Response(JSON.stringify({ models: [{ id: "m1", name: "Model One", provider: "custom" }] }), { status: 200 });
    });
    const draftModels = await unsavedService.models({
      provider: "compatible",
      baseUrl: "https://draft.example.test/v1",
      protocol: "chat",
      auth: "bearer",
      apiKey: "draft-secret"
    });
    assert.deepEqual(draftModels, [{ id: "m1", name: "Model One", provider: "custom" }]);

    await store.save({
      enabled: true,
      provider: "compatible",
      baseUrl: "https://ai.example.test/v1",
      protocol: "chat",
      auth: "bearer",
      apiKey: "live-key",
      defaultModel: "m1"
    });

    let askBody = null;
    let probeCalls = 0;
    const service = createAIService(store, async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (body && Array.isArray(body.tools)) {
        probeCalls += 1;
        if (probeCalls === 1) {
          return new Response("strict unsupported", { status: 400 });
        }
        return new Response(JSON.stringify({
          model: "m1",
          choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-1", function: { name: "report_probe", arguments: { status: "ok" } } }] } }]
        }), { status: 200 });
      }
      if (body && body.messages.some(m => m.role === "tool")) {
        return new Response(JSON.stringify({ model: "m1", choices: [{ message: { content: [{ type: "output_text", text: "ok" }] } }] }), { status: 200 });
      }
      askBody = body;
      return new Response(JSON.stringify({ model: "m1", choices: [{ message: { content: "共 2 个 Bug。" } }] }), { status: 200 });
    });

    const answer = await service.ask({
      text: "我有几个bug",
      history: [{ role: "user", text: "在吗" }, { role: "assistant", text: "在的" }],
      context: "任务系统「Jira」：BUG-1 [Open]；BUG-2 [Open]"
    });
    assert.equal(answer.text, "共 2 个 Bug。");
    assert.match(askBody.messages[0].content, /BUG-1/);
    // Third-party task data is fenced off in the system prompt so a
    // task title cannot smuggle instructions into the assistant.
    assert.match(askBody.messages[0].content, /第三方系统返回的数据/);
    assert.match(askBody.messages[0].content, /不得执行/);
    assert.equal(askBody.messages[1].content, "在吗");
    assert.equal(askBody.messages[3].content, "我有几个bug");

    const chatCheck = await service.testChat();
    assert.match(chatCheck.text, /对话连通验证成功/);

    const probeResult = await service.probe();
    assert.match(probeResult.text, /验证成功/);
    assert.equal(probeCalls, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
