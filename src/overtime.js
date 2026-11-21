const { normalizeAvatar } = require("./assistant-avatar");

const DEFAULT_SETTINGS = {
  oaUrl: "https://oa.yarward.com:35877/sp/em/main",
  workStart: "09:00",
  workEnd: "18:00",
  overtimeStart: "19:00",
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

function normalizeClock(value) {
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(String(value || "").trim());
  if (!match) {
    return "";
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    return "";
  }
  // Accept "9:00" as well as "09:00": always store the padded form.
  return String(hours).padStart(2, "0") + ":" + match[2];
}

function clampInteger(value, fallback, min, max) {
  // An empty field used to become 0 (Number("") === 0), not the default.
  if (value === "" || value === null || value === undefined) {
    return fallback;
  }
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
    // Only the company OA host may run with full bridge privileges:
    // the OA URL pins the origin every sender check trusts, so any
    // other https host here would hand those privileges to that site.
    if (parsed.protocol !== "https:" || parsed.hostname !== "oa.yarward.com") {
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
  const filteredWorkdays = Array.isArray(source.workdays)
    ? [...new Set(source.workdays.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort()
    : [];
  // An empty list used to be kept, silently disabling the workday
  // concept for downstream overtime logic.
  const workdays = filteredWorkdays.length ? filteredWorkdays : DEFAULT_SETTINGS.workdays.slice();
  return {
    oaUrl,
    workStart: normalizeClock(source.workStart) || DEFAULT_SETTINGS.workStart,
    workEnd: normalizeClock(source.workEnd) || DEFAULT_SETTINGS.workEnd,
    overtimeStart: normalizeClock(source.overtimeStart) || DEFAULT_SETTINGS.overtimeStart,
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
  // Keep the newest 200 entries: keys arrive in chronological order,
  // so slicing from the front would drop the newest submissions.
  Object.keys(input).slice(-200).forEach((key) => {
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

module.exports = {
  dateKey,
  normalizeData,
  normalizeAssistantTasks
};
