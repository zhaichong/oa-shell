const MESSAGE = ".oli-message";
const BODY = ".content.is-text, .rich-text-content, .mention-text, .content";
const IMAGE = "img:not(.oli-emoji-item-img):not(.error-image):not(.delete-image)";
const DECORATION = "svg, [aria-hidden='true'], button, [role='button'], [role='toolbar']";
const EDITABLE = "input, textarea, [contenteditable]:not([contenteditable='false'])";

// Same mapping as emojiPreview in message-popup.js: OA emoji are <img>
// with empty textContent, so copy text from the alt label instead.
function emojiText(alt) {
  const label = String(alt || "").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().replace(/^\[(.*)\]$/, "$1").trim();
  if (label === "含泪的笑脸") return "🥲";
  if (/\p{Extended_Pictographic}/u.test(label)) return label;
  return label ? "[" + label + "]" : "[表情]";
}

function plainText(fragment) {
  fragment.querySelectorAll(DECORATION).forEach(node => node.remove());
  fragment.querySelectorAll("br").forEach(node => node.replaceWith("\n"));
  fragment.querySelectorAll("p, div, li").forEach(node => {
    if (node.nextSibling) node.append("\n");
  });
  // Emoji images carry no text: replace each with its alt text so the
  // copied text keeps the emoji instead of dropping it ("收到 🥲" used
  // to copy as "收到 "). Other inline images have no text either: mark
  // them with their alt or [图片] instead of dropping them silently.
  fragment.querySelectorAll("img.oli-emoji-item-img").forEach(node => node.replaceWith(emojiText(node.getAttribute("alt"))));
  fragment.querySelectorAll("img").forEach(node => node.replaceWith(node.getAttribute("alt") || "[图片]"));
  return fragment.textContent;
}

function selectedChatText(win) {
  if (win.document.activeElement?.closest(EDITABLE)) return "";
  const selection = win.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return "";
  const range = selection.getRangeAt(0).cloneRange();
  const start = range.startContainer.nodeType === 1 ? range.startContainer : range.startContainer.parentElement;
  const first = start?.closest(MESSAGE);
  const body = start?.closest(BODY);
  if (!first || !body || !first.contains(body) || !first.contains(range.endContainer)) return "";
  if (!body.contains(range.endContainer)) range.setEnd(body, body.childNodes.length);
  return plainText(range.cloneContents());
}

function messageBodyText(message, target) {
  const body = target.closest(BODY);
  const content = body && message.contains(body) ? body : message.querySelector(BODY);
  return content ? plainText(content.cloneNode(true)).trim() : "";
}

function chatImage(message, target) {
  const attachment = ".image-content, .rich-text-content";
  const direct = target.closest(IMAGE);
  if (direct?.closest(attachment)) return direct;
  const imageBox = target.closest(".image-content");
  const images = (imageBox || message).querySelectorAll(IMAGE);
  const attachments = Array.from(images).filter(image => image.closest(attachment));
  return attachments.length === 1 ? attachments[0] : null;
}

function isCopyCommand(target, message) {
  if (message.contains(target) && target.closest(BODY)) return false;
  if (target.closest(":disabled, [aria-disabled='true']")) return false;
  for (let node = target, depth = 0; node && depth < 6; node = node.parentElement, depth += 1) {
    if (node === message || node === node.ownerDocument.body) return false;
    const label = node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent;
    if (/^(复制|复制图片|复制文本|copy|copy image|copy text)$/i.test(label?.trim())) return true;
    if (label?.length < 40 && node.querySelector("svg") &&
        /^(复制|复制图片|复制文本|copy|copy image|copy text)$/i.test(plainText(node.cloneNode(true)).trim())) return true;
  }
  return false;
}

async function imageOnClipboard(win, image, bridge) {
  if (!image.isConnected || !image.complete || !image.naturalWidth || !image.naturalHeight) return false;
  if (image.naturalWidth * image.naturalHeight <= 32_000_000) {
    try {
      const canvas = win.document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      if (await bridge.writeImage(canvas.toDataURL("image/png"))) return true;
    } catch {
      // Images served without CORS can still use Chromium's native image copy.
    }
  }
  const rect = image.getBoundingClientRect();
  for (const fx of [0.5, 0.2, 0.8]) {
    for (const fy of [0.5, 0.2, 0.8]) {
      const x = rect.left + rect.width * fx;
      const y = rect.top + rect.height * fy;
      if (win.document.elementFromPoint(x, y) === image) return bridge.copyImageAt(x, y);
    }
  }
  return false;
}

function installChatClipboard(win, bridge) {
  let context = null;
  let noticeTimer;

  function notify(ok) {
    let notice = win.document.getElementById("oa-chat-copy-status");
    if (!notice) {
      notice = win.document.createElement("div");
      notice.id = "oa-chat-copy-status";
      notice.className = "oa-image-preview-status";
      notice.setAttribute("role", "status");
      win.document.body.append(notice);
    }
    notice.textContent = ok ? "已复制到剪贴板" : "复制失败，请重试";
    win.clearTimeout(noticeTimer);
    noticeTimer = win.setTimeout(() => notice.remove(), 1800);
  }

  win.addEventListener("copy", event => {
    const text = selectedChatText(win);
    if (!text || !event.clipboardData) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  win.addEventListener("contextmenu", event => {
    const target = event.target;
    const message = target?.closest?.(MESSAGE);
    context = null;
    if (!message || target.closest(EDITABLE)) return;
    const selection = win.getSelection();
    const selected = message.contains(selection?.anchorNode) ? selectedChatText(win) : "";
    const image = selected ? null : chatImage(message, target);
    const text = selected || (!image ? messageBodyText(message, target) : "");
    if (image || text) context = { message, image, text, at: Date.now() };
  }, true);

  win.addEventListener("keydown", event => {
    if (event.key === "Escape") context = null;
  }, true);

  win.addEventListener("click", event => {
    const target = event.target;
    const captured = context;
    context = null;
    if (!captured || Date.now() - captured.at > 15_000 || !captured.message.isConnected ||
      !target?.closest || !isCopyCommand(target, captured.message)) return;
    // The hijack only applies to the OA right-click menu (a body-level
    // overlay). A "复制" button inside another message's hover toolbar
    // must keep working on that message instead of copying the
    // right-clicked one.
    const clickedMessage = target.closest(MESSAGE);
    if (clickedMessage && clickedMessage !== captured.message) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    win.document.body.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true }));
    win.document.body.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    Promise.resolve().then(() => captured.image
      ? imageOnClipboard(win, captured.image, bridge)
      : bridge.writeText(captured.text)).then(notify, () => notify(false));
  }, true);
}

module.exports = { installChatClipboard, emojiText };
