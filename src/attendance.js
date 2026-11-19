const { workPeriod } = require("./overtime-flows");

function monthRange(date) {
  const year = date.getFullYear();
  const month = date.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const monthText = String(month + 1).padStart(2, "0");
  return {
    monthKey: year + "-" + monthText,
    beginDate: year + "-" + monthText + "-01",
    endDate: year + "-" + monthText + "-" + String(lastDay).padStart(2, "0")
  };
}

const WORK_END_MINUTES = 18 * 60;
const OVERTIME_PUNCH_MINUTES = 19 * 60;

function displayValue(value) {
  if (value && typeof value === "object") {
    return [value.value, value.displayValue, value.text].find(item => typeof item === "string" && item.trim()) || "";
  }
  if (value == null) {
    return "";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value.trim();
  }
  return "";
}

function clockMinutes(value) {
  const match = displayValue(value).match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return null;
  }
  return hour * 60 + minute;
}

function formatClock(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
}

function formatDuration(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  if (hour && minute) {
    return hour + " 小时 " + minute + " 分钟";
  }
  if (hour) {
    return hour + " 小时";
  }
  if (minute) {
    return minute + " 分钟";
  }
  return "0 分钟";
}

function clockValue(item) {
  if (typeof item === "string" || typeof item === "number") {
    return item;
  }
  if (!item || typeof item !== "object") {
    return "";
  }
  if (item.signTime && typeof item.signTime === "object") {
    return item.signTime.value || "";
  }
  return item.time || item.value || item.signTime || "";
}

function latestPunch(day) {
  const clocks = day && (Array.isArray(day.clocks) ? day.clocks : []);
  let latest = null;
  clocks.forEach((item) => {
    const minutes = clockMinutes(clockValue(item));
    if (minutes == null) {
      return;
    }
    if (latest == null || minutes > latest) {
      latest = minutes;
    }
  });
  return latest;
}

function dateKey(value) {
  const match = displayValue(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    return "";
  }
  return match[1] + "-" + match[2] + "-" + match[3];
}

function isOvertimeLink(link, knownOvertimeRow) {
  if (!link || typeof link !== "object" || /退回|撤销|作废|删除|草稿/.test(link.statusName || link.status || "")) return false;
  const id = displayValue(link.flowid || link.flowId || link.requestId || link.requestid || link.workflowId || link.dataId || link.requestMark);
  if (!id || (link.linktype && !/^(flow|workflow|overtime|apply|\d+)$/i.test(String(link.linktype)))) return false;
  const name = displayValue(link.linkname || link.flowName || link.requestName || link.title || link.name || link.requestMark);
  return name ? /加班|YHJBSQ/i.test(name) : knownOvertimeRow;
}

function linkedPeriod(row) {
  return workPeriod({
    startDate: displayValue(row.beginDate || row.startDate || row.overtimeDate),
    endDate: displayValue(row.endDate),
    startTime: displayValue(row.startTime || row.beginTime),
    endTime: displayValue(row.endTime)
  });
}

function appliedDateKeys(payload, punches) {
  const data = payload && (payload.data || payload);
  const keys = new Map();
  function record(link, parentRange, attendanceDay) {
    const range = linkedPeriod(link) || parentRange;
    const dates = range ? range.dates : [dateKey(attendanceDay)].filter(Boolean);
    for (const date of dates) {
      keys.set(date, range?.period || keys.get(date) || "");
    }
  }
  for (const rows of [data?.displayData, data?.datas, data?.list, data?.records]) {
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row !== "object") continue;
      const range = linkedPeriod(row);
      const day = row.attendDate || row.workDate || row.signDate;
      if (isOvertimeLink(row, true)) record(row, range, day);
      for (const link of Array.isArray(row.attendMsglink) ? row.attendMsglink : []) {
        if (isOvertimeLink(link, false)) record(link, range, day);
      }
    }
  }
  for (const day of Array.isArray(punches) ? punches : []) {
    for (const link of Array.isArray(day?.flows) ? day.flows : []) {
      if (isOvertimeLink(link, false)) record(link, null, day.date);
    }
  }
  return keys;
}

function punchRows(punches, detail) {
  const applied = appliedDateKeys(detail, punches);
  const latestByDate = new Map();
  (Array.isArray(punches) ? punches : []).forEach((day) => {
    const key = dateKey(day && day.date);
    const latest = latestPunch(day);
    if (!key || latest == null) {
      return;
    }
    const previous = latestByDate.get(key);
    if (previous == null || latest > previous) {
      latestByDate.set(key, latest);
    }
  });
  return Array.from(latestByDate.keys()).sort().map((key) => {
    const latest = latestByDate.get(key);
    if (latest < OVERTIME_PUNCH_MINUTES) {
      return null;
    }
    return {
      id: key,
      date: key.slice(5),
      text: formatClock(WORK_END_MINUTES) + "\u2013" + formatClock(latest) + " \u00b7 " + formatDuration(latest - WORK_END_MINUTES),
      minutes: latest - WORK_END_MINUTES,
      ...(applied.get(key) ? { applicationPeriod: applied.get(key) } : {}),
      applied: applied.has(key)
    };
  }).filter(Boolean);
}

function hasAnyClock(punches) {
  return (Array.isArray(punches) ? punches : []).some((day) => latestPunch(day) != null);
}

function statisReady(statis) {
  if (!statis || statis.msg === "not-json") {
    return false;
  }
  const code = statis.code || statis.status;
  if (code && Number(code) !== 200) {
    return Boolean(statis.data);
  }
  return true;
}

function normalizeAttendance(statis, detail, range, punches) {
  const rows = punchRows(punches, detail);
  const failed = !statisReady(statis) && !hasAnyClock(punches);
  const minutes = rows.reduce((sum, row) => sum + row.minutes, 0);
  const unappliedCount = failed ? 0 : rows.filter((row) => !row.applied).length;
  return {
    state: failed ? "error" : "ready",
    message: failed ? ((statis && statis.msg) || "出勤统计没有返回") : "",
    monthKey: range.monthKey,
    totalText: failed ? "" : formatDuration(minutes),
    totalLabel: "加班",
    unappliedCount,
    details: failed ? [] : rows.map((row) => ({
      id: row.id,
      date: row.date,
      text: row.text,
      ...(row.applicationPeriod ? { applicationPeriod: row.applicationPeriod } : {}),
      applied: row.applied
    }))
  };
}

function pageFetchExpression(range) {
  const begin = JSON.stringify(range.beginDate);
  const end = JSON.stringify(range.endDate);
  return "(async () => {\n" +
    "  const sid = window.ETEAMSID || (window.sessionStorage && sessionStorage.getItem('E10_ETEAMSID_LOCAL')) || '';\n" +
    "  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };\n" +
    "  if (sid) { headers.ETEAMSID = sid; headers.eteamsid = sid; }\n" +
    "  async function post(url, body, query) {\n" +
    "    const target = query ? url + '?' + new URLSearchParams(body).toString() : url;\n" +
    "    const response = await fetch(target, { method: 'POST', credentials: 'include', headers: headers, body: query ? undefined : JSON.stringify(body) });\n" +
    "    const text = await response.text();\n" +
    "    try { return JSON.parse(text); } catch (error) { return { code: response.status, msg: 'not-json' }; }\n" +
    "  }\n" +
    "  function addClock(clocks, item) {\n" +
    "    if (!item || typeof item !== 'object') return;\n" +
    "    if (Array.isArray(item.signInfo)) { item.signInfo.forEach((entry) => addClock(clocks, entry)); return; }\n" +
    "    const sign = item.signTime && typeof item.signTime === 'object' ? item.signTime : null;\n" +
    "    const value = sign ? sign.value : (typeof item.signTime === 'string' ? item.signTime : (item.value || item.time || ''));\n" +
    "    if (value == null || value === '') return;\n" +
    "    const title = sign ? sign.title : (item.title || '');\n" +
    "    clocks.push({ title: String(title || '').slice(0, 24), time: String(value).slice(0, 32) });\n" +
    "  }\n" +
    "  function collectClocks(data) {\n" +
    "    const clocks = [];\n" +
    "    const root = data && (Array.isArray(data.signInfo) ? data.signInfo : (data.data || data.list || []));\n" +
    "    (Array.isArray(root) ? root : []).forEach((item) => addClock(clocks, item));\n" +
    "    return clocks;\n" +
    "  }\n" +
    "  function listDates(startText, endText) {\n" +
    "    const startPart = startText.split('-').map(Number);\n" +
    "    const endPart = endText.split('-').map(Number);\n" +
    "    const cursor = new Date(startPart[0], startPart[1] - 1, startPart[2]);\n" +
    "    const last = new Date(endPart[0], endPart[1] - 1, endPart[2]);\n" +
    "    const now = new Date();\n" +
    "    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());\n" +
    "    const dates = [];\n" +
    "    while (cursor <= last && cursor <= today) {\n" +
    "      dates.push(cursor.getFullYear() + '-' + String(cursor.getMonth() + 1).padStart(2, '0') + '-' + String(cursor.getDate()).padStart(2, '0'));\n" +
    "      cursor.setDate(cursor.getDate() + 1);\n" +
    "    }\n" +
    "    return dates;\n" +
    "  }\n" +
    "  function collectFlows(data) {\n" +
    "    const flows = [];\n" +
    "    const seen = new Set();\n" +
    "    function addLink(item, depth) {\n" +
    "      if (!item || typeof item !== 'object' || depth > 6 || seen.has(item)) return;\n" +
    "      seen.add(item);\n" +
    "      if (Array.isArray(item)) {\n" +
    "        item.forEach((entry) => addLink(entry, depth + 1));\n" +
    "        return;\n" +
    "      }\n" +
    "      const flowId = item.flowid || item.flowId || item.requestId || item.requestid || item.workflowId || item.dataId || item.requestMark;\n" +
    "      const name = String(item.linkname || item.flowName || item.requestName || item.title || item.name || '').slice(0, 60);\n" +
    "      if (flowId) {\n" +
    "        flows.push({ linktype: String(item.linktype || 'flow'), linkname: name, flowid: String(flowId).slice(0, 40), status: item.statusName || item.status, startDate: item.startDate || item.beginDate || item.overtimeDate, endDate: item.endDate, startTime: item.startTime || item.beginTime, endTime: item.endTime });\n" +
    "      }\n" +
    "      Object.keys(item).forEach((key) => {\n" +
    "        if (item[key] && typeof item[key] === 'object') addLink(item[key], depth + 1);\n" +
    "      });\n" +
    "    }\n" +
    "    addLink(data, 0);\n" +
    "    return flows;\n" +
    "  }\n" +
    "  async function loadDay(date) {\n" +
    "    const user = window.TEAMS && window.TEAMS.currentUser && window.TEAMS.currentUser.id;\n" +
    "    const body = user ? { date: date, userId: user } : { date: date };\n" +
    "    try {\n" +
    "      let res = await post('/api/attend/web/attendInfoV2/getCalendarDetailByDate', body, false);\n" +
    "      if (!res || res.msg === 'not-json' || (res.code && Number(res.code) !== 200 && !(res.data && res.data.signInfo))) {\n" +
    "        const again = await post('/api/app/attend/web/attendInfoV2/getCalendarDetailByDate', body, false);\n" +
    "        if (again && again.data) res = again;\n" +
    "      }\n" +
    "      return { date: date, clocks: collectClocks(res && res.data), flows: collectFlows(res && res.data) };\n" +
    "    } catch (error) {\n" +
    "      return { date: date, clocks: [], flows: [] };\n" +
    "    }\n" +
    "  }\n" +
    "  const monthBody = { beginDate: " + begin + ", endDate: " + end + " };\n" +
    "  let statis = await post('/api/attend/web/attendInfoV2/getAttendInfoStatis', monthBody, false);\n" +
    "  if (!statis || (statis.code && Number(statis.code) !== 200 && !(statis.data && statis.data.attendSummary))) {\n" +
    "    statis = await post('/api/app/attend/web/attendInfoV2/getAttendInfoStatis', monthBody, false);\n" +
    "  }\n" +
    "  const detailBody = { type: 'OVERTIME', originBeginDate: " + begin + ", originEndDate: " + end + ", beginDate: " + begin + ", endDate: " + end + ", current: '1', pageSize: '100' };\n" +
    "  let detail = await post('/api/attend/web/attendInfoV2/getAttendInfoDetail', detailBody, false);\n" +
    "  if (!detail || Number(detail.code) === 500 || !(detail.data && (detail.data.displayData || detail.data.datas || detail.data.list))) {\n" +
    "    const again = await post('/api/attend/web/attendInfoV2/getAttendInfoDetail', detailBody, true);\n" +
    "    if (again && again.data) detail = again;\n" +
    "  }\n" +
    "  const dates = listDates(" + begin + ", " + end + ");\n" +
    "  const punches = [];\n" +
    "  for (let index = 0; index < dates.length; index += 4) {\n" +
    "    const part = await Promise.all(dates.slice(index, index + 4).map(loadDay));\n" +
    "    part.forEach((item) => punches.push(item));\n" +
    "  }\n" +
    "  return { statis: statis, detail: detail, punches: punches };\n" +
    "})()";
}

module.exports = {
  monthRange,
  normalizeAttendance,
  pageFetchExpression
};
