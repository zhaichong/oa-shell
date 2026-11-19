const { app, BrowserWindow, ipcMain, safeStorage, session } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { createIntegrationStore, normalizeConnection, previewTasks } = require("../src/integrations");
const { createAIStore, createAIService } = require("../src/ai-gateway");

let directory;
let server;
const watchdog = setTimeout(() => { console.error("Integration UI test timed out"); app.exit(1); }, 45000);

app.whenReady().then(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "oa-integrations-ui-"));
  const file = path.join(directory, "integrations.json");
  const store = createIntegrationStore(file, {
    encrypt: secret => safeStorage.encryptStringAsync(secret),
    decrypt: async cipher => (await safeStorage.decryptStringAsync(cipher)).result
  });
  const network = session.fromPartition("integration-ui-test-" + process.pid);
  const aiStore = createAIStore(path.join(directory, "ai-settings.json"), {});
  const aiService = createAIService(aiStore, async (url, options) => {
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "fixture/grok" }] });
    return new Promise((_resolve, reject) => {
      if (options.signal.aborted) return reject(options.signal.reason);
      options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
    });
  });
  ipcMain.handle("ai:config", () => aiStore.get());
  ipcMain.handle("ai:models", (_event, draft) => aiService.models(draft));
  ipcMain.handle("ai:models-cached", () => []);
  ipcMain.handle("ai:history", () => []);
  ipcMain.handle("ai:save", (_event, draft) => aiStore.save(draft));
  ipcMain.handle("ai:test-chat", () => aiService.testChat());
  ipcMain.handle("ai:cancel", () => aiService.cancel());
  server = http.createServer((request, response) => {
    assert.equal(request.method, "GET");
    if (request.url === "/cookie-tasks") {
      assert.equal(request.headers.cookie, "session=fixture-cookie");
      assert.equal(request.headers.authorization, undefined);
    } else {
      assert.equal(request.headers.authorization, "Basic " + Buffer.from("demo:fixture-secret").toString("base64"));
      assert.equal(request.headers.cookie, undefined);
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: { items: [{ id: "BUG-1", title: "模拟任务：修复登录状态", status: "待处理", assignee: "测试人员", priority: "高" }] } }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = "http://127.0.0.1:" + server.address().port;
  await network.cookies.set({ url: baseUrl, name: "session", value: "fixture-cookie" });
  const browserResult = await previewTasks(normalizeConnection({ name: "Cookie test", kind: "json", baseUrl, allowHttp: true, auth: "browser", endpoint: "/cookie-tasks", mappings: { records: "data.items", title: "title" } }), "", (url, options) => network.fetch(String(url), options));
  assert.equal(browserResult.items.length, 1);
  ipcMain.handle("state:get", () => ({ panelOpen: true, attendance: { state: "ready", details: [] } }));
  ipcMain.handle("connections:list", () => store.list());
  ipcMain.handle("connections:save", (_event, input) => store.save(input));
  ipcMain.handle("connections:preview", async (_event, id) => {
    const { config, secret } = await store.resolve(id);
    return previewTasks(config, secret, (url, options) => network.fetch(String(url), options));
  });
  const window = new BrowserWindow({ width: 920, height: 900, show: false, webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, "../out/preload/index.js") } });
  const errors = [];
  window.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  await window.loadFile(path.join(__dirname, "../out/renderer/index.html"));
  const script = `async () => {
    const wait = () => new Promise(resolve => setTimeout(resolve, 50));
    const button = text => Array.from(document.querySelectorAll('button')).find(item => item.textContent.trim() === text);
    const fill = async (label, value) => {
      const container = Array.from(document.querySelectorAll('label')).find(item => item.textContent.trim().startsWith(label));
      const control = container.querySelector('input,select,textarea');
      control.value = value;
      control.dispatchEvent(new Event(control.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
      await wait();
    };
    await wait();
    button('接入设置').click();
    await wait();
    await fill('系统名称', '测试任务系统');
    await fill('系统类型', 'json');
    await fill('系统地址', ${JSON.stringify(baseUrl)});
    document.querySelector('input[type=checkbox]').click();
    await fill('认证方式', 'basic');
    await fill('用户名 / 邮箱', 'demo');
    await fill('认证凭证', 'fixture-secret');
    document.querySelector('button[type=submit]').click();
    for (let count = 0; count < 50 && !document.querySelector('.result'); count++) await wait();
    const saved = document.querySelector('.result')?.textContent || '';
    const secretCleared = document.querySelector('input[type=password]').value === '';
    button('预览任务').click();
    for (let count = 0; count < 50 && !document.querySelector('.preview li'); count++) await wait();
    return { saved, secretCleared, task: document.querySelector('.preview li')?.textContent || '', overflow: document.documentElement.scrollWidth > window.innerWidth };
  }`;
  const result = await window.webContents.executeJavaScript("(" + script + ")()");
  assert.match(result.saved, /配置已保存/);
  assert.equal(result.secretCleared, true);
  assert.match(result.task, /BUG-1/);
  assert.equal(result.overflow, false);
  assert.equal(fs.readFileSync(file, "utf8").includes("fixture-secret"), false);
  assert.equal(JSON.stringify(store.list()).includes("fixture-secret"), false);
  window.setSize(360, 780);
  const narrowOverflow = await window.webContents.executeJavaScript("document.documentElement.scrollWidth > window.innerWidth");
  assert.equal(narrowOverflow, false);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(__dirname, "../dist/integrations-preview.png"), (await window.webContents.capturePage()).toPNG());
  const aiResult = await window.webContents.executeJavaScript(`(async () => {
    const button = label => [...document.querySelectorAll('button')].find(el => el.textContent.trim() === label);
    async function until(check) {
      for (let i = 0; i < 80; i++) {
        if (check()) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('AI settings did not reach expected state');
    }
    button('AI 模型').click();
    await until(() => button('检测网关 / 刷新模型') && !button('检测网关 / 刷新模型').matches(':disabled'));
    button('检测网关 / 刷新模型').click();
    await until(() => document.querySelector('#ai-stage-defaultModel')?.value === 'fixture/grok');
    [...document.querySelectorAll('label')].find(el => el.textContent.includes('启用分身 AI')).querySelector('input').click();
    button('保存设置').click();
    await until(() => !button('测试对话连通').matches(':disabled'));
    button('测试对话连通').click();
    await until(() => button('停止 AI 请求') && !button('停止 AI 请求').matches(':disabled'));
    button('停止 AI 请求').click();
    await until(() => document.querySelector('.ai-settings .result.failed')?.textContent.includes('停止'));
    return document.documentElement.scrollWidth <= window.innerWidth;
  })()`);
  assert.equal(aiResult, true);
  assert.equal(aiStore.get().defaultModel, "fixture/grok");
  assert.equal(aiService.isRunning(), false);
  console.log("Integration UI regression passed: save, encrypted credentials, GET preview, narrow layout");
  window.destroy();
  server.close();
  fs.rmSync(directory, { recursive: true, force: true });
  clearTimeout(watchdog);
  app.exit(0);
}).catch(error => {
  console.error(error);
  if (server) server.close();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  app.exit(1);
});
