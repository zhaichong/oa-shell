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
    const match = /^(\d{1,2}):(\d{1,2})(?:\s+(\S(?:.*\S)?))?$/.exec(arg);
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
      at: String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0"),
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
    "/取消 提交加班：取消今天还没到点的提醒",
    "/取消 18:00 提交加班：只取消这个时间的提醒"
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
  // Below-threshold rows (counted === false) are shown in the list but
  // are not overtime: they need no application and must not count here.
  // Rows whose applied state is unknown (detail fetch failed) are not
  // counted either: they may already have an application.
  const pending = details.filter((item) => item.counted !== false && !item.applied && !item.appliedUnknown);
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

function cancelReminder(tasks, text, now = new Date()) {
  const normalized = normalizeAssistantTasks(tasks);
  // Only today's pending reminders: cancelling by text must not kill
  // the same reminder on another day.
  const key = dateKey(now);
  const pending = normalized.filter((task) => !task.fired && !task.cancelled && task.dateKey === key);
  // "/取消 18:00 提交加班" cancels only the reminder at that time.
  const timed = /^(\d{1,2}):(\d{1,2})\s+(.+)$/.exec(text);
  if (timed) {
    const at = timed[1].padStart(2, "0") + ":" + timed[2].padStart(2, "0");
    const rest = timed[3];
    const atTime = pending.filter((task) => task.at === at);
    // Any text that matches more than one reminder at this time is
    // ambiguous, even when it exactly equals one of them: "提交加班"
    // is the full text of one reminder and the start of another
    // ("提交加班申请"), so cancelling on it would silently kill the
    // wrong one. Refuse and ask for the full text instead.
    const matches = atTime.filter((task) => task.text.includes(rest));
    if (matches.length > 1) {
      return {
        ok: false,
        tasks: normalized,
        message: at + " 有 " + matches.length + " 条包含“" + rest + "”的提醒，分别是 " + matches.map((task) => task.text).join("、") + "，请写完整内容"
      };
    }
    const chosen = matches;
    if (!chosen.length) {
      return { ok: false, tasks: normalized, message: at + " 没有找到提醒：" + rest };
    }
    const ids = new Set(chosen.map((task) => task.id));
    const next = normalized.map((task) => ids.has(task.id) ? { ...task, cancelled: true } : task);
    return {
      ok: true,
      tasks: next,
      message: "已取消 " + chosen.map((task) => task.at + " " + task.text).join("、")
    };
  }
  const exact = pending.filter((task) => task.text === text);
  if (exact.length > 1) {
    const times = exact.map((task) => task.at).join("、");
    return {
      ok: false,
      tasks: normalized,
      message: "有 " + exact.length + " 条“" + text + "”提醒，分别在 " + times + "，请加上时间，比如：/取消 " + exact[0].at + " " + text
    };
  }
  const chosen = exact.length ? exact : pending.filter((task) => task.text.includes(text));
  if (!chosen.length) {
    const otherDay = normalized.some((task) => !task.fired && !task.cancelled && task.dateKey !== key && (task.text === text || task.text.includes(text)));
    return {
      ok: false,
      tasks: normalized,
      message: otherDay ? "找到的提醒不在今天，没有取消。" : "没有找到未到点的提醒。"
    };
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
    // A reminder from a past day fires once (late) instead of silently
    // never firing; a future day's reminder is not due yet.
    const overdue = task.dateKey < key || (task.dateKey === key && parseAt(task.at) <= minutes);
    if (task.cancelled || task.fired || !overdue) {
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
