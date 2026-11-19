const { dateKey, normalizeAssistantTasks } = require("./overtime");

function fail(message) {
  return { ok: false, message };
}

function parseCommand(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return fail("请输入命令，例如 /帮助");
  }
  if (text[0] !== "/") {
    return fail("命令需要以 / 开头。输入 /帮助 查看用法。");
  }
  const body = text.slice(1).trim();
  if (!body || body === "帮助" || body === "help") {
    return { ok: true, name: "help" };
  }
  const splitAt = body.indexOf(" ");
  const name = splitAt === -1 ? body : body.slice(0, splitAt);
  const arg = splitAt === -1 ? "" : body.slice(splitAt + 1).trim();
  if (name === "加班") {
    return arg ? fail("/加班 不需要其他内容。") : { ok: true, name: "overtime" };
  }
  if (name === "刷新") {
    return arg ? fail("/刷新 不需要其他内容。") : { ok: true, name: "refresh" };
  }
  if (name === "打开") {
    if (arg === "工作消息" || arg === "消息") {
      return { ok: true, name: "open", target: "messages" };
    }
    if (arg === "首页") {
      return { ok: true, name: "open", target: "home" };
    }
    return fail("可以打开“工作消息”或“首页”。");
  }
  if (name === "提醒") {
    const match = /^(\d{1,2}):(\d{2})(?:\s+(\S(?:.*\S)?))?$/.exec(arg);
    if (!match || !match[3]) {
      return fail("用法：/提醒 18:00 提交加班");
    }
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) {
      return fail("时间需要在 00:00 到 23:59 之间。");
    }
    return {
      ok: true,
      name: "remind",
      at: String(hour).padStart(2, "0") + ":" + match[2],
      text: match[3].slice(0, 40)
    };
  }
  if (name === "取消") {
    return arg ? { ok: true, name: "cancel", text: arg.slice(0, 40) } : fail("用法：/取消 提交加班");
  }
  return fail("没有这个命令。输入 /帮助 查看用法。");
}

function helpText() {
  return [
    "/加班：查看本月加班申请匹配情况",
    "/刷新：重新读取出勤",
    "/打开 工作消息：打开工作消息",
    "/打开 首页：打开 OA 首页",
    "/提醒 18:00 提交加班：到点后本机提醒一次",
    "/取消 提交加班：取消还没到点的提醒"
  ].join("\n");
}

function formatOvertime(attendance) {
  if (!attendance || attendance.state === "loading") {
    return "正在读取出勤，请稍后再用 /加班。";
  }
  if (attendance.state === "login") {
    return "请先登录 OA，再查看加班。";
  }
  if (attendance.state === "error") {
    return attendance.message || "暂时无法读取出勤。";
  }
  const details = Array.isArray(attendance.details) ? attendance.details : [];
  const pending = details.filter((item) => !item.applied);
  const total = attendance.totalText ? String(attendance.totalText) : "暂无汇总";
  if (!pending.length) {
    return "本月加班 " + total + "。所有记录均已匹配申请。";
  }
  const lines = pending.slice(0, 8).map((item) => String(item.date || "") + " " + String(item.text || ""));
  const extra = pending.length > 8 ? "\n还有 " + (pending.length - 8) + " 条。" : "";
  return "本月加班 " + total + "。待核对 " + pending.length + " 条：\n" + lines.join("\n") + extra;
}

function clockMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function parseAt(at) {
  const [hour, minute] = at.split(":").map(Number);
  return hour * 60 + minute;
}

function taskId(key, at, text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return "t" + key.replace(/-/g, "") + at.replace(":", "") + (hash >>> 0).toString(36);
}

function addReminder(tasks, now, at, text) {
  const normalized = normalizeAssistantTasks(tasks);
  if (parseAt(at) < clockMinutes(now)) {
    return { ok: false, tasks: normalized, message: "这个时间今天已经过了。" };
  }
  const key = dateKey(now);
  const id = taskId(key, at, text);
  const existing = normalized.find((task) => task.id === id);
  if (existing && !existing.fired && !existing.cancelled) {
    return { ok: false, tasks: normalized, message: "已经有 " + at + " 的提醒：" + text };
  }
  const next = normalized.filter((task) => task.id !== id);
  next.push({ id, at, text, dateKey: key, fired: false, cancelled: false });
  return { ok: true, tasks: next, message: "已记下 " + at + " 提醒：" + text };
}

function cancelReminder(tasks, text) {
  const normalized = normalizeAssistantTasks(tasks);
  const pending = normalized.filter((task) => !task.fired && !task.cancelled);
  const exact = pending.filter((task) => task.text === text);
  const chosen = exact.length ? exact : pending.filter((task) => task.text.includes(text));
  if (!chosen.length) {
    return { ok: false, tasks: normalized, message: "没有找到未到点的提醒。" };
  }
  if (!exact.length && chosen.length > 1) {
    return { ok: false, tasks: normalized, message: "有多条相似提醒，请输入完整内容。" };
  }
  const ids = new Set(chosen.map((task) => task.id));
  const next = normalized.map((task) => ids.has(task.id) ? { ...task, cancelled: true } : task);
  return {
    ok: true,
    tasks: next,
    message: "已取消 " + chosen.map((task) => task.at + " " + task.text).join("、")
  };
}

function collectDueReminders(tasks, now) {
  const normalized = normalizeAssistantTasks(tasks);
  const key = dateKey(now);
  const minutes = clockMinutes(now);
  const due = [];
  const next = normalized.map((task) => {
    if (task.cancelled || task.fired || task.dateKey !== key || parseAt(task.at) > minutes) {
      return task;
    }
    due.push(task);
    return { ...task, fired: true };
  });
  return { tasks: next, due };
}

module.exports = {
  parseCommand,
  helpText,
  formatOvertime,
  addReminder,
  cancelReminder,
  collectDueReminders
};
