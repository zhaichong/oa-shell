const MAX_SENDER_LENGTH = 40;
const MAX_CONTENT_LENGTH = 160;

const SENDER_KEYS = [
  "sender",
  "senderName",
  "fromName",
  "fromUserName",
  "userName",
  "username",
  "targetName",
  "sessionName",
  "chatName",
  "title",
  "name",
  "nickName"
];

const CONTENT_KEYS = [
  "content",
  "body",
  "text",
  "message",
  "msg",
  "summary",
  "lastMessage",
  "lastMsg",
  "preview",
  "description",
  "subtitle"
];

const NESTED_KEYS = ["data", "message", "msg", "session", "notice", "notification"];

const GENERIC_SENDERS = new Set([
  "新消息",
  "消息提醒",
  "工作消息",
  "亚华 OA",
  "亚华OA",
  "OA",
  "消息通知"
]);

const FALLBACK_CONTENT = new Set(["收到一条新消息", "收到一条新消息，点击查看", "发来一条新消息"]);

function collapseWhitespace(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
}

function stripUnreadPrefix(value) {
  return collapseWhitespace(value).replace(/^(?:\s*\[\d+\+?条(?:未读)?\]\s*)+/, "").trim();
}

function isGenericSender(sender) {
  const text = collapseWhitespace(sender);
  return Boolean(text && GENERIC_SENDERS.has(text));
}

function splitSenderContent(text) {
  const cleaned = stripUnreadPrefix(text);
  if (!cleaned || cleaned[0] === "[") {
    return null;
  }
  const match = /^([^:：\n]{1,24}?)\s*[:：]\s*(.+)$/.exec(cleaned);
  if (!match) {
    return null;
  }
  const candidate = collapseWhitespace(match[1]);
  const rest = stripUnreadPrefix(match[2]);
  if (!candidate || !rest) {
    return null;
  }
  if (rest.startsWith("//") || /^(?:https?|ftp|mailto|file|tel)$/i.test(candidate)) {
    return null;
  }
  if (/^\d+$/.test(candidate) && /^\d/.test(rest)) {
    return null;
  }
  return { sender: candidate, content: rest };
}

function unwrapCandidate(value) {
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : null;
  }
  return value;
}

function collectCandidateObjects(value) {
  const root = unwrapCandidate(value);
  if (!root || typeof root !== "object") {
    return [];
  }
  const list = [root];
  for (let index = 0; index < NESTED_KEYS.length; index += 1) {
    const nested = unwrapCandidate(root[NESTED_KEYS[index]]);
    if (nested && typeof nested === "object") {
      list.push(nested);
    }
  }
  return list;
}

function pickSender(objects) {
  let fallback = "";
  for (let keyIndex = 0; keyIndex < SENDER_KEYS.length; keyIndex += 1) {
    const key = SENDER_KEYS[keyIndex];
    for (let objIndex = 0; objIndex < objects.length; objIndex += 1) {
      const value = collapseWhitespace(objects[objIndex][key]);
      if (!value) {
        continue;
      }
      if (!isGenericSender(value)) {
        return value;
      }
      if (!fallback) {
        fallback = value;
      }
    }
  }
  return fallback;
}

function pickContent(objects) {
  for (let keyIndex = 0; keyIndex < CONTENT_KEYS.length; keyIndex += 1) {
    const key = CONTENT_KEYS[keyIndex];
    for (let objIndex = 0; objIndex < objects.length; objIndex += 1) {
      const value = stripUnreadPrefix(objects[objIndex][key]);
      if (value) {
        return value;
      }
    }
  }
  return "";
}

/**
 * Normalize message payloads from Web Notification, Electron remote Notification,
 * or OA IPC payloads into `{ sender, content }`, or `null` when empty.
 * @param {unknown} input
 * @param {unknown} [extra]
 * @returns {{ sender: string, content: string } | null}
 */
function normalizeMessagePayload(input, extra) {
  let sender = "";
  let content = "";

  if (typeof input === "string") {
    const trimmed = collapseWhitespace(input);
    if (typeof extra === "string") {
      sender = trimmed;
      content = stripUnreadPrefix(extra);
    } else if (extra && typeof extra === "object") {
      const objects = collectCandidateObjects(extra);
      const extractedSender = pickSender(objects);
      if (extractedSender && (!isGenericSender(extractedSender) || !trimmed)) {
        sender = extractedSender;
      } else {
        sender = trimmed || extractedSender;
      }
      content = pickContent(objects);
    } else if (trimmed) {
      const split = splitSenderContent(trimmed);
      if (split) {
        sender = split.sender;
        content = split.content;
      } else if (isGenericSender(trimmed)) {
        sender = trimmed;
      } else {
        content = stripUnreadPrefix(trimmed);
      }
    }
  } else if (input && typeof input === "object") {
    const objects = collectCandidateObjects(input).concat(collectCandidateObjects(extra));
    sender = pickSender(objects);
    content = pickContent(objects);
    if (!content && typeof extra === "string") {
      content = stripUnreadPrefix(extra);
    }
  }

  sender = collapseWhitespace(sender);
  content = stripUnreadPrefix(content);

  if (!content && sender) {
    const splitFromSender = splitSenderContent(sender);
    if (splitFromSender) {
      sender = splitFromSender.sender;
      content = splitFromSender.content;
    }
  }

  if ((!sender || isGenericSender(sender)) && content) {
    const split = splitSenderContent(content);
    if (split) {
      sender = split.sender;
      content = split.content;
    }
  }

  if (!sender && !content) {
    return null;
  }

  return {
    sender: sender.slice(0, MAX_SENDER_LENGTH),
    content: content.slice(0, MAX_CONTENT_LENGTH)
  };
}

function hasClass(node, className) {
  if (!node) {
    return false;
  }
  if (node.classList && typeof node.classList.contains === "function") {
    return node.classList.contains(className);
  }
  return new RegExp("(^|\\s)" + className + "(\\s|$)").test(String(node.className || ""));
}

function isHiddenNode(node) {
  if (!node) {
    return true;
  }
  if (node.hidden === true) {
    return true;
  }
  if (node.style && node.style.display === "none") {
    return true;
  }
  return false;
}

function isAssistantPin(item) {
  if (!item) {
    return false;
  }
  return item.id === "oa-shell-assistant" || hasClass(item, "oa-assistant-pin");
}

function findImRoot(doc) {
  if (!doc || typeof doc.querySelector !== "function") {
    return null;
  }
  return doc.querySelector(".weapp-em-im-main-layout") || doc.querySelector(".weapp-main-em:not(.im-hide)") || null;
}

function queryList(node, selector) {
  if (!node || typeof node.querySelectorAll !== "function") {
    return [];
  }
  return Array.from(node.querySelectorAll(selector));
}

function isOutgoingSessionPreview(lastEl) {
  if (!lastEl) {
    return false;
  }
  const raw = collapseWhitespace(lastEl.textContent || "");
  if (/^\[(?:未读|已读)\]/.test(raw)) {
    return true;
  }
  const receipts = queryList(lastEl, ".last-message-unread, .last-message-readed");
  for (let index = 0; index < receipts.length; index += 1) {
    const node = receipts[index];
    if (isHiddenNode(node)) {
      continue;
    }
    if (hasClass(node, "last-message-readed")) {
      return true;
    }
    const text = collapseWhitespace(node.textContent || "");
    if (/^\[?(?:未读|已读)\]?$/.test(text)) {
      return true;
    }
  }
  return false;
}

function extractLastText(lastEl) {
  if (!lastEl) {
    return "";
  }
  return stripUnreadPrefix(lastEl.textContent || "");
}

function isSessionUnread(item, lastEl) {
  if (isOutgoingSessionPreview(lastEl)) {
    return false;
  }
  if (hasClass(item, "is-unread") || hasClass(item, "unread")) {
    return true;
  }
  const rawLast = collapseWhitespace(lastEl ? lastEl.textContent : "");
  if (/^\[\d+\+?条(?:未读)?\]/.test(rawLast)) {
    return true;
  }
  const badges = queryList(item, '.ui-badge, .badge, [class*="badge"], .unread-count, .unread-dot');
  for (let index = 0; index < badges.length; index += 1) {
    const badge = badges[index];
    if (badge === lastEl || isHiddenNode(badge) || (typeof badge.closest === "function" && badge.closest(".last"))) {
      continue;
    }
    const text = collapseWhitespace(badge.textContent || "");
    if (/^(?:[1-9]\d*\+?|\[\d+\+?条\])$/.test(text)) {
      return true;
    }
    if (!text && /\b(?:ui-badge-dot|badge-dot|unread-dot)\b/i.test(String(badge.className || ""))) {
      return true;
    }
  }
  return false;
}

function readSessionItems(root) {
  const items = queryList(root, ".session-item");
  const result = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (isAssistantPin(item) || isHiddenNode(item)) {
      continue;
    }
    const nameEl = (item.querySelector && (item.querySelector(".name .span-text") || item.querySelector(".name"))) || null;
    const sender = collapseWhitespace(nameEl ? nameEl.textContent : "");
    const lastEl = item.querySelector ? item.querySelector(".last") : null;
    const content = extractLastText(lastEl);
    const unread = isSessionUnread(item, lastEl);
    const active = hasClass(item, "is-active") || hasClass(item, "active");
    const attrId = typeof item.getAttribute === "function"
      ? (item.getAttribute("data-id") || item.getAttribute("data-session-id") || "")
      : "";
    const datasetId = item.dataset ? (item.dataset.id || item.dataset.sessionId || "") : "";
    const key = attrId || datasetId || sender;
    if (!key) {
      continue;
    }
    result.push({
      key,
      sender: sender.slice(0, MAX_SENDER_LENGTH),
      content: content.slice(0, MAX_CONTENT_LENGTH),
      unread,
      active,
      index: result.length
    });
  }
  return result;
}

function readOliMessageContent(msgEl) {
  if (!msgEl) {
    return "";
  }
  const textNode = msgEl.querySelector
    ? (msgEl.querySelector(".content.is-text") || msgEl.querySelector(".mention-text") || msgEl.querySelector(".content"))
    : null;
  if (textNode) {
    const text = stripUnreadPrefix(textNode.textContent || "");
    if (text) {
      return text;
    }
  }
  if (msgEl.querySelector && msgEl.querySelector(".image-content img")) {
    return "[图片]";
  }
  if (msgEl.querySelector && msgEl.querySelector(".file-content")) {
    return "[文件]";
  }
  return stripUnreadPrefix(msgEl.textContent || "");
}

function resolveActiveChatName(root, sessions) {
  const titleEl = root.querySelector ? root.querySelector(".title-bar .name") : null;
  const title = collapseWhitespace(titleEl ? titleEl.textContent : "");
  if (title) {
    return title.slice(0, MAX_SENDER_LENGTH);
  }
  const activeSession = sessions.find((item) => item.active);
  return activeSession ? activeSession.sender : "";
}

function readActiveIncomingMessage(root, sessions) {
  const sender = resolveActiveChatName(root, sessions);
  const messages = queryList(root, ".message-main .oli-message");
  const list = messages.length ? messages : queryList(root, ".oli-message");
  if (!list.length) {
    return null;
  }
  const lastMsg = list[list.length - 1];
  if (hasClass(lastMsg, "me")) {
    return null;
  }
  const content = readOliMessageContent(lastMsg).slice(0, MAX_CONTENT_LENGTH);
  if (!sender || !content) {
    return null;
  }
  const id = typeof lastMsg.getAttribute === "function"
    ? (lastMsg.getAttribute("data-id") || lastMsg.getAttribute("data-msg-id") || "")
    : "";
  return {
    sender,
    content,
    element: lastMsg,
    count: list.length,
    sig: id || (sender + "\n" + content)
  };
}

/**
 * Extract the most relevant incoming message from the OA IM DOM.
 * Prefers the first unread `.session-item`; falls back to the latest non-outgoing
 * `.oli-message` in the active chat.
 * @param {Document} doc
 * @returns {{ sender: string, content: string, unread: boolean } | null}
 */
function extractDomSessionMessage(doc) {
  const root = findImRoot(doc);
  if (!root) {
    return null;
  }
  const sessions = readSessionItems(root);
  const unreadItem = sessions.find((item) => item.unread && item.sender && item.content);
  if (unreadItem) {
    return {
      sender: unreadItem.sender,
      content: unreadItem.content,
      unread: true
    };
  }
  const activeMsg = readActiveIncomingMessage(root, sessions);
  if (activeMsg) {
    return {
      sender: activeMsg.sender,
      content: activeMsg.content,
      unread: false
    };
  }
  return null;
}

/**
 * Observe OA IM DOM mutations for newly arrived incoming messages while ignoring
 * the initial session snapshot and messages sent by the current user.
 * @param {Document} doc
 * @param {(message: { sender: string, content: string }) => void} onMessage
 * @param {{ debounceMs?: number, now?: () => number, schedule?: typeof setTimeout, cancel?: typeof clearTimeout, MutationObserverImpl?: typeof MutationObserver }} [options]
 * @returns {{ check: () => void, disconnect: () => void }}
 */
function installDomMessageObserver(doc, onMessage, options = {}) {
  if (!doc || typeof onMessage !== "function") {
    return { check() {}, disconnect() {} };
  }
  const now = typeof options.now === "function" ? options.now : Date.now;
  const schedule = typeof options.schedule === "function"
    ? options.schedule
    : (typeof setTimeout === "function" ? setTimeout : null);
  const cancel = typeof options.cancel === "function"
    ? options.cancel
    : (typeof clearTimeout === "function" ? clearTimeout : null);
  const debounceMs = typeof options.debounceMs === "number" ? options.debounceMs : 50;
  const ObserverCtor = options.MutationObserverImpl
    || (doc.defaultView && doc.defaultView.MutationObserver)
    || (typeof MutationObserver !== "undefined" ? MutationObserver : null);

  const prevSessions = new Map();
  let hasSessionBaseline = false;
  let prevTopKey = "";
  let activeChatKey = "";
  let activeChatBaselineReady = false;
  let prevLastMsgEl = null;
  let prevLastMsgSig = "";
  let lastSessionSwitchAt = 0;
  let awaitingSwitchLoad = false;
  let lastUserScrollAt = 0;
  let lastUserSent = { text: "", at: 0 };
  let lastEmittedKey = "";
  let lastEmittedAt = 0;
  let pendingTimer = null;
  let observer = null;

  function emit(message) {
    if (!message || !message.sender || !message.content) {
      return;
    }
    const timestamp = now();
    if (lastUserSent.text && timestamp - lastUserSent.at < 1500 && message.content === lastUserSent.text) {
      return;
    }
    const key = message.sender + "\n" + message.content;
    if (key === lastEmittedKey && timestamp - lastEmittedAt < 400) {
      return;
    }
    lastEmittedKey = key;
    lastEmittedAt = timestamp;
    onMessage({ sender: message.sender, content: message.content });
  }

  function readComposerText() {
    const root = findImRoot(doc) || doc;
    if (!root || typeof root.querySelector !== "function") {
      return "";
    }
    const input = root.querySelector(".chat-input textarea, .chat-input .ql-editor, .chat-input [contenteditable='true']");
    if (!input) {
      return "";
    }
    const raw = typeof input.value === "string" ? input.value : (input.textContent || "");
    return collapseWhitespace(raw);
  }

  function recordUserSend() {
    const text = readComposerText();
    if (text) {
      lastUserSent = { text: text.slice(0, MAX_CONTENT_LENGTH), at: now() };
    }
  }

  function onScroll(event) {
    const target = event && event.target;
    if (target && typeof target.closest === "function" && target.closest(".session")) {
      lastUserScrollAt = now();
    }
  }

  function onKeydown(event) {
    if (!event || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.isComposing) {
      return;
    }
    const target = event.target;
    if (target && typeof target.closest === "function" && target.closest(".chat-input, .chat-input-main, .chat-input-container")) {
      recordUserSend();
    }
  }

  function onClick(event) {
    const target = event && event.target;
    if (!target || typeof target.closest !== "function") {
      return;
    }
    if (target.closest(".send-button-wrapper, .send-btn, .send-button")) {
      recordUserSend();
      return;
    }
    const sessionItem = target.closest(".session-item");
    if (sessionItem && !isAssistantPin(sessionItem) && !hasClass(sessionItem, "is-active") && !hasClass(sessionItem, "active")) {
      lastSessionSwitchAt = now();
      awaitingSwitchLoad = true;
      activeChatBaselineReady = false;
    }
  }

  function signatureOfMessage(root, sessions, msgEl) {
    if (!msgEl || hasClass(msgEl, "me")) {
      return "";
    }
    const activeMsg = readActiveIncomingMessage(root, sessions);
    return activeMsg ? activeMsg.sig : "";
  }

  function check() {
    if (pendingTimer !== null && cancel) {
      cancel(pendingTimer);
      pendingTimer = null;
    }
    const root = findImRoot(doc);
    if (!root) {
      return;
    }
    const sessions = readSessionItems(root);
    const scrolling = now() - lastUserScrollAt < 800;

    if (sessions.length > 0) {
      if (!hasSessionBaseline) {
        for (let index = 0; index < sessions.length; index += 1) {
          const item = sessions[index];
          prevSessions.set(item.key, { content: item.content, unread: item.unread, index: item.index });
        }
        prevTopKey = sessions[0].key;
        hasSessionBaseline = true;
      } else {
        const nextTopKey = sessions[0].key;
        for (let index = 0; index < sessions.length; index += 1) {
          const item = sessions[index];
          const prev = prevSessions.get(item.key);
          if (item.unread && item.sender && item.content) {
            const isNewUnread = !prev && !scrolling;
            const changedUnread = Boolean(prev && (item.content !== prev.content || !prev.unread));
            const movedToTop = Boolean(
              prev && prev.unread && item.index === 0 && prevTopKey !== item.key && item.index < prev.index
            );
            if (isNewUnread || changedUnread || movedToTop) {
              emit({ sender: item.sender, content: item.content });
            }
          }
          prevSessions.set(item.key, { content: item.content, unread: item.unread, index: item.index });
        }
        prevTopKey = nextTopKey;
      }
    }

    const currentChatKey = resolveActiveChatName(root, sessions);
    const mainMessages = queryList(root, ".message-main .oli-message");
    const messages = mainMessages.length ? mainMessages : queryList(root, ".oli-message");
    const lastMsgEl = messages.length ? messages[messages.length - 1] : null;
    const withinSwitchWindow = now() - lastSessionSwitchAt <= 1200;

    if (currentChatKey !== activeChatKey) {
      const staleSameDom = Boolean(awaitingSwitchLoad && withinSwitchWindow && lastMsgEl && lastMsgEl === prevLastMsgEl);
      activeChatKey = currentChatKey;
      lastSessionSwitchAt = now();
      prevLastMsgEl = lastMsgEl;
      prevLastMsgSig = signatureOfMessage(root, sessions, lastMsgEl);
      if (lastMsgEl && !staleSameDom) {
        activeChatBaselineReady = true;
        awaitingSwitchLoad = false;
      } else {
        activeChatBaselineReady = false;
      }
      return;
    }

    if (!lastMsgEl) {
      prevLastMsgEl = null;
      prevLastMsgSig = "";
      activeChatBaselineReady = false;
      return;
    }

    const isFirstSwitchLoad = !activeChatBaselineReady
      || Boolean(awaitingSwitchLoad && withinSwitchWindow && prevLastMsgEl && messages.indexOf(prevLastMsgEl) === -1);

    if (isFirstSwitchLoad) {
      prevLastMsgEl = lastMsgEl;
      prevLastMsgSig = signatureOfMessage(root, sessions, lastMsgEl);
      activeChatBaselineReady = true;
      awaitingSwitchLoad = false;
      return;
    }

    if (hasClass(lastMsgEl, "me")) {
      prevLastMsgEl = lastMsgEl;
      prevLastMsgSig = "";
      return;
    }

    const activeMsg = readActiveIncomingMessage(root, sessions);
    const sig = activeMsg ? activeMsg.sig : "";
    const prevIndex = prevLastMsgEl ? messages.indexOf(prevLastMsgEl) : -1;
    const appended = prevLastMsgEl !== null
      && lastMsgEl !== prevLastMsgEl
      && (prevIndex !== -1 ? prevIndex < messages.length - 1 : sig !== prevLastMsgSig);

    if (appended && activeMsg) {
      emit({ sender: activeMsg.sender, content: activeMsg.content });
    }
    prevLastMsgEl = lastMsgEl;
    prevLastMsgSig = sig;
  }

  function scheduleCheck() {
    if (!schedule || debounceMs <= 0) {
      check();
      return;
    }
    if (pendingTimer !== null && cancel) {
      cancel(pendingTimer);
    }
    pendingTimer = schedule(() => {
      pendingTimer = null;
      check();
    }, debounceMs);
  }

  if (typeof doc.addEventListener === "function") {
    doc.addEventListener("keydown", onKeydown, true);
    doc.addEventListener("click", onClick, true);
    doc.addEventListener("scroll", onScroll, true);
    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", check);
    }
  }

  check();

  if (ObserverCtor) {
    const target = doc.body || doc.documentElement || doc;
    if (target) {
      observer = new ObserverCtor(scheduleCheck);
      observer.observe(target, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["class", "hidden"]
      });
    }
  }

  return {
    check,
    disconnect() {
      if (pendingTimer !== null && cancel) {
        cancel(pendingTimer);
        pendingTimer = null;
      }
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (typeof doc.removeEventListener === "function") {
        doc.removeEventListener("keydown", onKeydown, true);
        doc.removeEventListener("click", onClick, true);
        doc.removeEventListener("scroll", onScroll, true);
        doc.removeEventListener("DOMContentLoaded", check);
      }
    }
  };
}

/**
 * Compute bottom-right popup bounds within a display work area.
 * @param {{ x?: number, y?: number, width?: number, height?: number }} [workArea]
 * @param {{ width?: number, height?: number, margin?: number }} [size]
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function computePopupBounds(workArea, size) {
  const area = workArea || {};
  const areaX = Number.isFinite(Number(area.x)) ? Number(area.x) : 0;
  const areaY = Number.isFinite(Number(area.y)) ? Number(area.y) : 0;
  const areaWidth = Number.isFinite(Number(area.width)) && Number(area.width) > 0 ? Number(area.width) : 1280;
  const areaHeight = Number.isFinite(Number(area.height)) && Number(area.height) > 0 ? Number(area.height) : 720;

  const opts = size || {};
  const width = Math.min(areaWidth, Number.isFinite(Number(opts.width)) && Number(opts.width) > 0 ? Number(opts.width) : 336);
  const height = Math.min(areaHeight, Number.isFinite(Number(opts.height)) && Number(opts.height) > 0 ? Number(opts.height) : 116);
  const margin = Number.isFinite(Number(opts.margin)) && Number(opts.margin) >= 0 ? Number(opts.margin) : 16;

  return {
    x: Math.round(Math.max(areaX, areaX + areaWidth - width - margin)),
    y: Math.round(Math.max(areaY, areaY + areaHeight - height - margin)),
    width: Math.round(width),
    height: Math.round(height)
  };
}

function isFallbackMessage(message) {
  if (!message) {
    return true;
  }
  return isGenericSender(message.sender) && (!message.content || FALLBACK_CONTENT.has(message.content));
}

/**
 * Manage popup visibility, short-term deduplication, fallback replacement,
 * and automatic dismissal after `durationMs`.
 * @param {{ showPopup: (payload: { sender: string, content: string }) => void, hidePopup: () => void, durationMs?: number, dedupeMs?: number, schedule?: typeof setTimeout, cancel?: typeof clearTimeout, now?: () => number }} options
 */
function createPopupController({
  showPopup,
  hidePopup,
  durationMs = 5000,
  dedupeMs = 1500,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = Date.now
}) {
  let open = false;
  let active = null;
  let timer = null;
  let lastKey = "";
  let lastShownAt = 0;

  function clearAutoTimer() {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
  }

  function dismiss() {
    clearAutoTimer();
    const wasOpen = open;
    open = false;
    active = null;
    if (wasOpen) {
      hidePopup();
    }
    return wasOpen;
  }

  function show(payload) {
    const normalized = normalizeMessagePayload(payload);
    if (!normalized) {
      return false;
    }
    const next = {
      sender: normalized.sender || "工作消息",
      content: normalized.content || "收到一条新消息"
    };
    const timestamp = now();
    const key = next.sender + "\n" + next.content;

    if (key === lastKey && timestamp - lastShownAt < dedupeMs) {
      return false;
    }
    if (open && active && !isFallbackMessage(active) && isFallbackMessage(next) && timestamp - lastShownAt < dedupeMs) {
      return false;
    }

    clearAutoTimer();
    open = true;
    active = next;
    lastKey = key;
    lastShownAt = timestamp;
    showPopup({ ...next });
    timer = schedule(() => {
      timer = null;
      dismiss();
    }, durationMs);
    return true;
  }

  return {
    show,
    dismiss,
    isOpen: () => open,
    current: () => (active ? { ...active } : null)
  };
}

/**
 * Build standalone HTML for the bottom-right message popup BrowserWindow.
 * Follows DESIGN.md rules (Flex layout only, no CSS Grid or gap, 150ms transitions).
 * @returns {string}
 */
function buildPopupHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>新消息提醒</title>
<style>
  html,
  body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #ffffff;
    color: #222c38;
    font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
    user-select: none;
  }

  .popup-card {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    width: 100%;
    height: 100%;
    padding: 10px 14px 12px;
    border: 1px solid #d9e0ea;
    border-top: 3px solid #3555c5;
    background: #ffffff;
    cursor: pointer;
    outline: none;
    transition: background-color 150ms ease-out;
  }

  .popup-card:hover {
    background: #f7f9fc;
  }

  .popup-card:focus-visible {
    outline: 2px solid #3555c5;
    outline-offset: -2px;
  }

  .popup-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-width: 0;
  }

  .popup-brand {
    display: flex;
    align-items: center;
    min-width: 0;
    color: #586575;
    font-size: 12px;
    line-height: 16px;
  }

  .popup-icon {
    display: block;
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    margin-right: 6px;
  }

  .popup-close {
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    margin-left: 8px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: #586575;
    font-family: inherit;
    font-size: 16px;
    line-height: 1;
    cursor: pointer;
    transition: background-color 150ms ease-out, color 150ms ease-out;
  }

  .popup-close:hover {
    background: #eef2f7;
    color: #222c38;
  }

  .popup-close:focus-visible {
    outline: 2px solid #3555c5;
    outline-offset: 1px;
  }

  .popup-body {
    display: flex;
    flex-direction: column;
    min-width: 0;
    margin-top: 6px;
  }

  .popup-sender {
    overflow: hidden;
    color: #222c38;
    font-size: 14px;
    font-weight: 600;
    line-height: 20px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .popup-content {
    display: -webkit-box;
    overflow: hidden;
    margin-top: 4px;
    color: #586575;
    font-size: 13px;
    line-height: 18px;
    word-break: break-word;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
  }

  @media (prefers-reduced-motion: reduce) {
    .popup-card,
    .popup-close {
      transition: none;
    }
  }
</style>
</head>
<body>
  <div id="popupCard" class="popup-card" role="button" tabindex="0" aria-label="查看新消息">
    <div class="popup-head">
      <div class="popup-brand">
        <svg class="popup-icon" viewBox="0 0 64 64" aria-hidden="true">
          <defs>
            <linearGradient id="popupIconBg" x1="6" y1="4" x2="58" y2="60" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#4c6ef5"></stop>
              <stop offset="55%" stop-color="#3555c5"></stop>
              <stop offset="100%" stop-color="#1f348a"></stop>
            </linearGradient>
          </defs>
          <rect x="2" y="2" width="60" height="60" rx="15" fill="url(#popupIconBg)"></rect>
          <path d="M46.5 15.5c1.8 0 3.1 1.9 2.2 3.5l-11 18.8a3.5 3.5 0 0 1-3 1.7h-5.4l10.3-17.6 3.7-6.4h3.2z" fill="#bcd0ff"></path>
          <path d="M17.5 15.5h6.7c1.3 0 2.5.7 3.1 1.8L35 30.8V48c0 2-1.6 3.5-3.5 3.5h-2.4a3.5 3.5 0 0 1-3.5-3.5V34.6L15.3 19c-.9-1.6.3-3.5 2.2-3.5z" fill="#ffffff"></path>
          <circle cx="47.5" cy="46.5" r="4" fill="#63e6be"></circle>
        </svg>
        <span>OA · 新消息</span>
      </div>
      <button id="popupClose" class="popup-close" type="button" aria-label="关闭消息提醒" title="关闭">×</button>
    </div>
    <div class="popup-body">
      <div id="popupSender" class="popup-sender">工作消息</div>
      <div id="popupContent" class="popup-content">收到一条新消息</div>
    </div>
  </div>
  <script>
    (function () {
      var card = document.getElementById("popupCard");
      var closeBtn = document.getElementById("popupClose");
      var senderEl = document.getElementById("popupSender");
      var contentEl = document.getElementById("popupContent");

      window.__renderPopup = function (payload) {
        var data = payload && typeof payload === "object" ? payload : {};
        var sender = typeof data.sender === "string" && data.sender ? data.sender : "工作消息";
        var content = typeof data.content === "string" && data.content ? data.content : "收到一条新消息";
        senderEl.textContent = sender;
        contentEl.textContent = content;
        card.setAttribute("aria-label", sender + "：" + content);
      };

      function openMessage() {
        window.location.href = "https://oa-popup.local/open";
      }

      function closePopup(event) {
        if (event) {
          event.stopPropagation();
        }
        window.location.href = "https://oa-popup.local/close";
      }

      closeBtn.addEventListener("click", closePopup);
      card.addEventListener("click", openMessage);
      card.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openMessage();
        } else if (event.key === "Escape") {
          event.preventDefault();
          closePopup();
        }
      });
    })();
  </script>
</body>
</html>`;
}

module.exports = {
  normalizeMessagePayload,
  isGenericSender,
  extractDomSessionMessage,
  installDomMessageObserver,
  computePopupBounds,
  createPopupController,
  buildPopupHtml
};
