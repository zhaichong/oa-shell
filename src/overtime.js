const { normalizeAvatar } = require("./assistant-avatar");

const DEFAULT_SETTINGS = {
  oaUrl: "https://oa.yarward.com:35877/sp/em/main",
  workStart: "09:00",
  workEnd: "18:00",
  overtimeRemindMinutes: 60,
  missedCheckInMinutes: 15,
  missedApplicationTime: "21:00",
  workdays: [1, 2, 3, 4, 5]
};

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function monthKey(date) {
  return dateKey(date).slice(0, 7);
}

function normalizeClock(value) {
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value || "");
  if (!match) {
    return "";
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return "";
  }
  return match[1] + ":" + match[2];
}

function parseTimeMinutes(value) {
  const clock = normalizeClock(value);
  if (!clock) {
    return null;
  }
  const [hours, minutes] = clock.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatMinutes(total) {
  const minutesTotal = Math.max(0, Math.round(total || 0));
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;
  if (hours === 0) {
    return `${minutes} 分钟`;
  }
  if (minutes === 0) {
    return `${hours} 小时`;
  }
  return `${hours} 小时 ${minutes} 分钟`;
}

function clampInteger(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

function normalizeOaUrl(value) {
  if (typeof value !== "string") {
    return DEFAULT_SETTINGS.oaUrl;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "https:") {
      return DEFAULT_SETTINGS.oaUrl;
    }
    if (parsed.hostname === "oa.yarward.com" && (parsed.pathname === "/" || parsed.pathname === "")) {
      parsed.pathname = "/sp/em/main";
      parsed.search = "";
      parsed.hash = "";
    }
    return parsed.toString();
  } catch (error) {
    return DEFAULT_SETTINGS.oaUrl;
  }
}

function normalizeSettings(input) {
  const source = input || {};
  const oaUrl = normalizeOaUrl(source.oaUrl);
  const workdays = Array.isArray(source.workdays)
    ? [...new Set(source.workdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
    : DEFAULT_SETTINGS.workdays.slice();
  return {
    oaUrl,
    workStart: normalizeClock(source.workStart) || DEFAULT_SETTINGS.workStart,
    workEnd: normalizeClock(source.workEnd) || DEFAULT_SETTINGS.workEnd,
    overtimeRemindMinutes: clampInteger(source.overtimeRemindMinutes, DEFAULT_SETTINGS.overtimeRemindMinutes, 0, 720),
    missedCheckInMinutes: clampInteger(source.missedCheckInMinutes, DEFAULT_SETTINGS.missedCheckInMinutes, 0, 180),
    missedApplicationTime: normalizeClock(source.missedApplicationTime) || DEFAULT_SETTINGS.missedApplicationTime,
    workdays
  };
}

function normalizeDay(input) {
  const source = input || {};
  return {
    checkIn: normalizeClock(source.checkIn),
    checkOut: normalizeClock(source.checkOut),
    applied: source.applied === true,
    forceWorkday: source.forceWorkday === true ? true : source.forceWorkday === false ? false : null
  };
}

function normalizeAssistantTasks(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  const seen = new Set();
  const tasks = [];
  input.forEach((item) => {
    const source = item || {};
    const at = normalizeClock(source.at);
    const key = typeof source.dateKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source.dateKey) ? source.dateKey : "";
    const taskText = typeof source.text === "string" ? source.text.trim().slice(0, 40) : "";
    const id = typeof source.id === "string" && /^[a-z0-9]{8,48}$/.test(source.id) ? source.id : "";
    if (!at || !key || !taskText || !id || seen.has(id)) {
      return;
    }
    seen.add(id);
    tasks.push({
      id,
      at,
      text: taskText,
      dateKey: key,
      fired: source.fired === true,
      cancelled: source.cancelled === true
    });
  });
  return tasks.slice(-30);
}

function normalizeSubmittedOvertimeDates(input) {
  const out = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return out;
  }
  Object.keys(input).slice(0, 200).forEach((key) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      return;
    }
    const entry = input[key];
    if (!entry || typeof entry !== "object") {
      return;
    }
    out[key] = {
        ...(typeof entry.period === "string" && entry.period ? { period: entry.period.slice(0, 48) } : {}),
      flowNo: typeof entry.flowNo === "string" ? entry.flowNo.slice(0, 40) : "",
      title: typeof entry.title === "string" ? entry.title.slice(0, 80) : "",
      at: typeof entry.at === "string" ? entry.at.slice(0, 40) : ""
    };
  });
  return out;
}

function normalizeData(input) {
  const source = input || {};
  const days = {};
  Object.keys(source.days || {}).forEach((key) => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      days[key] = normalizeDay(source.days[key]);
    }
  });
  const reminders = {};
  Object.keys(source.reminders || {}).forEach((key) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) {
      return;
    }
    const flags = source.reminders[key] || {};
    reminders[key] = {
      missedCheckIn: flags.missedCheckIn === true,
      overtime: flags.overtime === true,
      missedApplication: flags.missedApplication === true,
      missedCheckOut: flags.missedCheckOut === true
    };
  });
  return {
    settings: normalizeSettings(source.settings),
    days,
    reminders,
    window: source.window && typeof source.window === "object" ? source.window : null,
    panelOpen: source.panelOpen === true,
    assistantAvatar: normalizeAvatar(source.assistantAvatar),
    tasks: normalizeAssistantTasks(source.tasks),
    submittedOvertimeDates: normalizeSubmittedOvertimeDates(source.submittedOvertimeDates)
  };
}

function isWorkday(date, settings, day) {
  if (day && day.forceWorkday === true) {
    return true;
  }
  if (day && day.forceWorkday === false) {
    return false;
  }
  return settings.workdays.includes(date.getDay());
}

function clockMinutes(date) {
  return date.getHours() * 60 + date.getMinutes();
}

function overtimeMinutes(day, settings, now, key) {
  const start = parseTimeMinutes(day.checkIn);
  const endLimit = parseTimeMinutes(settings.workEnd);
  if (start === null || endLimit === null) {
    return 0;
  }
  const isToday = dateKey(now) === key;
  const end = day.checkOut ? parseTimeMinutes(day.checkOut) : isToday ? clockMinutes(now) : null;
  if (end === null || end <= start) {
    return 0;
  }
  const overtimeStart = Math.max(start, endLimit);
  if (end <= overtimeStart) {
    return 0;
  }
  return end - overtimeStart;
}

function presenceMinutes(day, now, key) {
  const start = parseTimeMinutes(day.checkIn);
  if (start === null) {
    return 0;
  }
  const isToday = dateKey(now) === key;
  const end = day.checkOut ? parseTimeMinutes(day.checkOut) : isToday ? clockMinutes(now) : null;
  if (end === null || end <= start) {
    return 0;
  }
  return end - start;
}

function describeDay(key, day, settings, now) {
  const record = normalizeDay(day);
  const date = new Date(`${key}T00:00:00`);
  const isToday = dateKey(now) === key;
  return {
    key,
    checkIn: record.checkIn,
    checkOut: record.checkOut,
    applied: record.applied,
    forceWorkday: record.forceWorkday,
    isWorkday: isWorkday(date, settings, record),
    overtimeMinutes: overtimeMinutes(record, settings, now, key),
    presenceMinutes: presenceMinutes(record, now, key),
    provisional: isToday && Boolean(record.checkIn) && !record.checkOut,
    missingCheckOut: !isToday && Boolean(record.checkIn) && !record.checkOut
  };
}

function buildSnapshot(data, now) {
  const normalized = normalizeData(data);
  const todayKey = dateKey(now);
  const currentMonth = monthKey(now);
  const today = describeDay(todayKey, normalized.days[todayKey], normalized.settings, now);
  const days = Object.keys(normalized.days)
    .filter((key) => key.startsWith(currentMonth))
    .sort()
    .reverse()
    .map((key) => describeDay(key, normalized.days[key], normalized.settings, now))
    .filter((day) => day.checkIn || day.checkOut || day.overtimeMinutes || day.missingCheckOut);
  const totalMinutes = days.reduce((sum, day) => sum + day.overtimeMinutes, 0);
  const unappliedMinutes = days.reduce((sum, day) => sum + (day.applied ? 0 : day.overtimeMinutes), 0);
  return {
    todayKey,
    monthKey: currentMonth,
    today,
    month: {
      key: currentMonth,
      totalMinutes,
      unappliedMinutes,
      days
    },
    settings: normalized.settings
  };
}

function previousDate(date) {
  const copy = new Date(date.getTime());
  copy.setDate(copy.getDate() - 1);
  return copy;
}

function collectReminders(data, now) {
  const normalized = normalizeData(data);
  const settings = normalized.settings;
  const todayKey = dateKey(now);
  const todayRecord = normalized.days[todayKey] || normalizeDay();
  const today = describeDay(todayKey, todayRecord, settings, now);
  const sentToday = normalized.reminders[todayKey] || {};
  const reminders = [];
  const nowMinutes = clockMinutes(now);
  const workStart = parseTimeMinutes(settings.workStart);
  if (
    today.isWorkday &&
    !today.checkIn &&
    workStart !== null &&
    nowMinutes >= workStart + settings.missedCheckInMinutes &&
    !sentToday.missedCheckIn
  ) {
    reminders.push({
      id: "missedCheckIn",
      dateKey: todayKey,
      title: "上班打卡提醒",
      body: "今天还没有记录上班时间。"
    });
  }
  if (
    today.isWorkday &&
    today.overtimeMinutes >= settings.overtimeRemindMinutes &&
    settings.overtimeRemindMinutes > 0 &&
    !today.applied &&
    !sentToday.overtime
  ) {
    reminders.push({
      id: "overtime",
      dateKey: todayKey,
      title: "加班时长提醒",
      body: `今天已加班 ${formatMinutes(today.overtimeMinutes)}，记得提交加班申请。`
    });
  }
  const applicationTime = parseTimeMinutes(settings.missedApplicationTime);
  if (
    today.isWorkday &&
    today.overtimeMinutes > 0 &&
    !today.applied &&
    applicationTime !== null &&
    nowMinutes >= applicationTime &&
    !sentToday.missedApplication
  ) {
    reminders.push({
      id: "missedApplication",
      dateKey: todayKey,
      title: "加班申请提醒",
      body: `今天加班 ${formatMinutes(today.overtimeMinutes)}，申请还没标记为已提交。`
    });
  }
  const yesterday = previousDate(now);
  const yesterdayKey = dateKey(yesterday);
  const yesterdayRecord = normalized.days[yesterdayKey];
  if (yesterdayRecord) {
    const yesterdayView = describeDay(yesterdayKey, yesterdayRecord, settings, now);
    const sentYesterday = normalized.reminders[yesterdayKey] || {};
    if (yesterdayView.isWorkday && yesterdayView.missingCheckOut && !sentYesterday.missedCheckOut) {
      reminders.push({
        id: "missedCheckOut",
        dateKey: yesterdayKey,
        title: "下班打卡提醒",
        body: `${yesterdayKey} 记了上班，但没有下班时间。`
      });
    }
  }
  return reminders;
}

module.exports = {
  DEFAULT_SETTINGS,
  dateKey,
  formatMinutes,
  normalizeData,
  normalizeDay,
  buildSnapshot,
  collectReminders,
  normalizeAssistantTasks,
  normalizeOaUrl
};
