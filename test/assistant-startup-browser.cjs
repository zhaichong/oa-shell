const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, clipboard, ipcMain, session, webContents } = require("electron");

// Exercise the production main entry with a disposable OA session and a local fixture.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "oa-startup-test-"));
app.setPath("appData", profile);
app.setPath("userData", profile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pages = () => webContents.getAllWebContents();
const sidebar = () => pages().find(page => page.getURL().startsWith("file:"));

async function waitFor(check) {
  for (let i = 0; i < 150; i++) {
    const result = await check();
    if (result) return result;
    await pause(50);
  }
  throw new Error("Timed out waiting for the application");
}

const today = new Date();
const month = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0");
const workDay = month + "-01";
app.whenReady().then(() => {
  session.fromPartition("persist:oa").protocol.handle("https", async request => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("getCalendarDetailByDate")) {
      const query = await request.json();
      return Response.json({ code: 200, data: { signInfo: query.date === workDay ? [{ signTime: "20:17" }] : [] } });
    }
    if (url.pathname.startsWith("/api/")) return Response.json({ code: 200, data: { displayData: [] } });
    const page = url.pathname === "/workflow/fixture"
      ? "<h1>加班申请</h1><p>申请时间 " + month + "-02 流程编号 YHJBSQ987</p><h2>加班信息</h2><p>开始日期 " + workDay + " 结束日期 " + workDay + "</p><p>开始时间 17:30 结束时间 20:00</p>"
      : '<main class="weapp-main-em"><div class="session">OA fixture</div></main>';
    return new Response("<html><body>" + page + "</body></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  });
});
fs.writeFileSync(path.join(profile, "overtime.json"), JSON.stringify({
  settings: { oaUrl: "https://oa.yarward.com:35877/sp/em/main" }
}));
require("../out/main/index.js");

async function verify() {
  const oa = await waitFor(() => pages().find(page => page.getURL().startsWith("https:") && !page.isLoading()));
  await pause(3200);
  const metrics = app.getAppMetrics();
  const privateKiB = metrics.reduce((sum, item) => sum + (item.memory.privateBytes || 0), 0);
  console.log("Startup sample", JSON.stringify({
    processes: metrics.length,
    renderers: metrics.filter(item => item.type === "Tab").length,
    privateMiB: Math.round(privateKiB / 1024),
    sidebarLoaded: Boolean(sidebar())
  }));
  assert.equal(Boolean(sidebar()), false, "chat-only startup must keep the assistant unloaded");
  // Opt in only with a disposable system clipboard.
  if (process.env.OA_TEST_CLIPBOARD === "1") {
    const link = "https://example.test/knowledge/full-link?doc=123456789&lang=zh#details";
    await oa.executeJavaScript(`(() => {
      const anchor = document.createElement("a");
      anchor.textContent = "https://example.test/…";
      anchor.href = ${JSON.stringify(link)};
      const button = document.createElement("button");
      button.onclick = () => window.emRequire("electron").clipboard.writeText(anchor.href);
      const target = document.createElement("textarea");
      target.id = "paste-check";
      document.body.append(anchor, button, target);
      button.click();
      target.focus();
    })()`, true);
    await waitFor(async () => (await clipboard.readText()) === link);
    assert.equal(await clipboard.readText(), link);
    oa.paste();
    await waitFor(() => oa.executeJavaScript("document.querySelector('#paste-check').value === " + JSON.stringify(link)));
    console.log("Full card link verified by native clipboard read and paste");
  }
  const event = { sender: oa };
  ipcMain.emit("assistant:bounds", event, { x: 300, y: 60, width: 620, height: 440 });
  assert.equal(sidebar(), undefined);
  ipcMain.emit("assistant:open", event);
  const ready = await waitFor(async () => {
    const view = sidebar();
    if (view && !view.isLoading() && await view.executeJavaScript("Boolean(document.querySelector('.thread'))")) return view;
  });
  const state = await ready.executeJavaScript("window.desk.getState()");
  assert.equal(state.panelOpen, true);
  ipcMain.emit("assistant:close", event);
  ipcMain.emit("assistant:open", event);
  assert.equal(sidebar(), ready);
  console.log("Assistant opened and reused");
  await waitFor(() => ready.executeJavaScript("Boolean(document.querySelector('.unapplied-pill'))"));
  await ready.executeJavaScript("document.querySelector('.unapplied-pill').click()");
  await waitFor(() => ready.executeJavaScript("Boolean(document.querySelector('.record .unapplied-badge'))"));
  await oa.executeJavaScript("window.open('/workflow/fixture'); true", true);
  const popup = await waitFor(() => pages().find(page => page.getURL().endsWith("/workflow/fixture") && !page.isLoading()));
  assert.equal(await popup.executeJavaScript("Boolean(window.__oaOvertimeMonitorInstalled)"), true, "OA popup must run the form monitor");
  assert.match(await popup.executeJavaScript("document.body.innerText"), /加班信息/);
  await waitFor(() => ready.executeJavaScript("document.querySelector('.record')?.textContent.includes('17:30–20:00')"));
  const updated = await ready.executeJavaScript("window.desk.getState()");
  assert.equal(updated.attendance.unappliedCount, 0);
  assert.equal(await ready.executeJavaScript("Boolean(document.querySelector('.unapplied-pill, .record .unapplied-badge'))"), false);
  assert.equal(await ready.executeJavaScript("document.querySelector('.record .application-badge')?.textContent"), "已申请");
  const saved = JSON.parse(fs.readFileSync(path.join(profile, "overtime.json"), "utf8"));
  assert.deepEqual(Object.keys(saved.submittedOvertimeDates), [workDay]);
  assert.equal(saved.submittedOvertimeDates[workDay].period, "17:30–20:00");
  console.log("OA form popup updated the existing card, count and persisted work date");
}

app.whenReady().then(verify).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
