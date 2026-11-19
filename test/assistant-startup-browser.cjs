const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BaseWindow, BrowserWindow, clipboard, ClipboardItem, ipcMain, nativeImage, session, webContents } = require("electron");

// Exercise the production main entry with a disposable OA session and a local fixture.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "oa-startup-test-"));
app.setPath("appData", profile);
app.setPath("userData", profile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const pages = () => webContents.getAllWebContents();
const sidebar = () => pages().find(page => page.getURL().startsWith("file:"));

async function waitFor(check, timeoutMs = 7500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
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
    if (url.pathname === "/fixture-copy.png") {
      const bitmap = Buffer.from([0, 0, 255, 255, 0, 255, 0, 255]);
      const png = nativeImage.createFromBitmap(bitmap, { width: 2, height: 1 }).toPNG();
      return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png" } });
    }
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
  const photoView = () => pages().find(page => page.getURL().includes("/sp/em/photoview"));
  assert.equal(photoView(), undefined, "chat-only startup must keep the photo viewer unloaded");
  await oa.executeJavaScript('window.emRequire("electron").ipcRenderer.send("init-photo-view"); true');
  await pause(100);
  assert.equal(photoView(), undefined, "the OA init signal must not preload the photo viewer");
  const host = BaseWindow.getAllWindows().find(window => window.contentView.children.some(view => view.webContents === oa));
  assert.ok(host);
  const desktopPopup = () => BrowserWindow.getAllWindows().find(window => (
    window.webContents.getURL().startsWith("data:text/html") && window.getBounds().width === 336
  ));
  const emojiHtml = '<img class="oli-emoji-item-img" alt="[含泪的笑脸]" style="width:16px; height:16px;">';
  const groupNotice = { sender: "项目成员", content: "收到了 " + emojiHtml, conversation: "事项的新反馈" };
  host.show();
  host.focus();
  await waitFor(() => host.isFocused());
  ipcMain.emit("oa:message", { sender: oa }, groupNotice);
  await pause(200);
  assert.equal(desktopPopup(), undefined, "opening unread messages in foreground must not produce a second desktop popup");
  host.hide();
  await oa.executeJavaScript(`new Notification("工作消息", {
    body: ${JSON.stringify(groupNotice.sender + "：" + groupNotice.content)},
    data: { groupName: ${JSON.stringify(groupNotice.conversation)} }
  }); true`);
  const toast = await waitFor(() => desktopPopup()?.isVisible() && desktopPopup());
  const displayed = await toast.webContents.executeJavaScript(
    '["#popupSender", "#popupContent"].map(selector => document.querySelector(selector).textContent)'
  );
  assert.deepEqual(displayed, [groupNotice.conversation, groupNotice.sender + "：收到了 🥲"]);
  if (process.env.OA_TEST_POPUP_PREVIEW) {
    await toast.webContents.executeJavaScript("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
    fs.writeFileSync(process.env.OA_TEST_POPUP_PREVIEW, (await toast.webContents.capturePage()).toPNG());
  }
  await oa.executeJavaScript(`(() => {
    const row = document.createElement("div");
    row.className = "session-item";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = ${JSON.stringify(groupNotice.conversation)};
    row.append(name);
    row.addEventListener("click", () => { document.body.dataset.chatOpened = name.textContent; });
    document.querySelector(".session").append(row);
  })()`);
  await toast.webContents.executeJavaScript('document.querySelector("#popupCard").click()');
  await waitFor(() => oa.executeJavaScript("document.body.dataset.chatOpened"));
  assert.equal(toast.isVisible(), false);
  console.log("Foreground suppressed; background group title, emoji and click-to-conversation verified");
  // Opt in only with a disposable system clipboard.
  if (process.env.OA_TEST_CLIPBOARD === "1") {
    const previous = await Promise.all((await clipboard.read()).map(async item => {
      const entries = await Promise.all(item.types.map(async type => [type, await item.getType(type)]));
      return new ClipboardItem(Object.fromEntries(entries));
    }));
    try {
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
      await oa.executeJavaScript("(" + (() => {
        document.activeElement.blur();
        const chat = document.createElement("div");
        chat.innerHTML = '<div id="copy-text" class="oli-message"><div class="content is-text">/theme1/home1<br>保留正文里的 svg<svg><title>svg</title></svg></div></div>' +
          '<div class="oli-message"><div class="image-content"><img id="copy-image" width="160" height="80"></div></div>' +
          '<button id="fixture-copy" role="menuitem"><svg><title>svg</title></svg><span>复制</span></button>';
        document.body.append(chat);
        const range = document.createRange();
        range.selectNodeContents(document.querySelector("#copy-text .content"));
        getSelection().removeAllRanges();
        getSelection().addRange(range);
        return true;
      }).toString() + ")()", true);
      oa.copy();
      const text = "/theme1/home1\n保留正文里的 svg";
      await waitFor(async () => (await clipboard.readText()).replace(/\r\n/g, "\n") === text);
      await oa.executeJavaScript("(" + (async () => {
        getSelection().removeAllRanges();
        const image = document.querySelector("#copy-image");
        image.src = "/fixture-copy.png";
        await image.decode();
        image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
        document.querySelector("#fixture-copy span").click();
      }).toString() + ")()", true);
      await waitFor(() => clipboard.has("image/png"));
      const items = await clipboard.read();
      const png = await items.find(item => item.types.includes("image/png")).getType("image/png");
      const copiedImage = nativeImage.createFromBuffer(Buffer.from(await png.arrayBuffer()));
      assert.deepEqual(copiedImage.getSize(), { width: 2, height: 1 });
      await clipboard.writeText("OA clipboard fixture");
      await oa.executeJavaScript("(" + (async () => {
        const image = document.querySelector("#copy-image");
        image.src = "https://image.example.test/fixture-copy.png";
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.getContext("2d").drawImage(image, 0, 0);
        try {
          canvas.toDataURL();
          throw new Error("Fixture image should block canvas readback");
        } catch (error) {
          if (error.name !== "SecurityError") throw error;
        }
        image.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
        document.querySelector("#fixture-copy span").click();
      }).toString() + ")()", true);
      await waitFor(() => clipboard.has("image/png"));
      console.log("Chat selection and image context menu verified in the Windows clipboard");
    } finally {
      if (previous.length) await clipboard.write(previous);
      else clipboard.clear();
    }
  }
  const event = { sender: oa };
  ipcMain.emit("oa:photo-ipc", event, "show-photo-view", {});
  const firstPhoto = await waitFor(() => photoView() && !photoView().isLoading() && photoView());
  ipcMain.emit("oa:photo-ipc", event, "close-photo-view");
  ipcMain.emit("oa:photo-ipc", event, "show-photo-view", {});
  assert.equal(photoView(), firstPhoto, "quick reopen must reuse the preview");
  ipcMain.emit("oa:photo-ipc", event, "close-photo-view");
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
  const firstSidebarId = ready.id;
  await ready.executeJavaScript(`(async () => {
    document.querySelector(".settings-entry").click();
    if (window.__captureAssistantSession() !== null) throw new Error("Settings must block reclaim");
    document.querySelector(".settings-entry").click();
    await Promise.resolve();
    const composer = document.querySelector("#assistant-command");
    composer.value = "未发送的分身草稿";
    composer.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  ipcMain.emit("assistant:close", event);
  await waitFor(() => firstPhoto.isDestroyed(), 35_000);
  await waitFor(() => ready.isDestroyed(), 35_000);
  assert.equal(photoView(), undefined);
  assert.equal(sidebar(), undefined);
  console.log("Idle preview and assistant web contents released");
  ipcMain.emit("assistant:open", event);
  const reopened = await waitFor(async () => {
    const view = sidebar();
    if (view && !view.isLoading() && await view.executeJavaScript(
      'document.querySelector("#assistant-command")?.value === "未发送的分身草稿" && Boolean(document.querySelector(".record .application-badge"))'
    )) return view;
  });
  assert.notEqual(reopened.id, firstSidebarId);
  ipcMain.emit("oa:photo-ipc", event, "show-photo-view", {});
  await waitFor(() => photoView() && !photoView().isLoading());
  console.log("Both views reopened; assistant draft and conversation restored");
}

app.whenReady().then(verify).then(() => app.quit()).catch(error => {
  console.error(error);
  app.exit(1);
});
