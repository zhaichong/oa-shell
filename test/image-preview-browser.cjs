const { app, BrowserWindow } = require("electron");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

app.whenReady().then(async () => {
  const popup = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  await popup.loadURL("data:text/html;charset=utf-8," + encodeURIComponent("<html><body><div class='oli-message'><div class='image-content'><img class='image' alt='测试图片'></div></div></body></html>"));
  await popup.webContents.insertCSS(fs.readFileSync(path.join(__dirname, "../resources/oa-theme.css"), "utf8"));
  const source = fs.readFileSync(path.join(__dirname, "../src/image-preview.js"), "utf8");
  const result = await popup.webContents.executeJavaScript(`(async () => {
    const module = { exports: {} };
    ${source}
    const feedback = module.exports.installImagePreview(window);
    let opens = 0;
    const image = document.querySelector('img');
    document.querySelector('.image-content').addEventListener('click', () => { opens += 1; });
    const click = (detail) => image.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail }));
    click(1);
    const loading = document.querySelector('[role="status"]').textContent;
    const singleOpens = opens;
    click(2);
    image.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
    const repeatedOpens = opens;
    const viewer = document.createElement('div');
    viewer.className = 'PhotoView-Portal';
    viewer.style.cssText = 'position:fixed;inset:0';
    document.body.appendChild(viewer);
    await new Promise(resolve => setTimeout(resolve, 0));
    const cleared = !document.querySelector('[role="status"]');
    viewer.remove();
    feedback.finish();
    click(2);
    const blockedTrailingDouble = opens;
    click(1);
    const reopened = opens;
    window.dispatchEvent(new Event('blur'));
    const blurCleared = !document.querySelector('[role="status"]');
    return { loading, singleOpens, repeatedOpens, cleared, blockedTrailingDouble, reopened, blurCleared };
  })()`);
  assert.deepEqual(result, {
    loading: "正在打开图片…",
    singleOpens: 1,
    repeatedOpens: 1,
    cleared: true,
    blockedTrailingDouble: 1,
    reopened: 2,
    blurCleared: true
  });
  console.log("Image preview browser regression passed");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
