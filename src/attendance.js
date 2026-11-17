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

function summaryList(payload) {
  const data = payload && payload.data;
  const summary = data && data.attendSummary;
  if (Array.isArray(summary)) {
    return summary;
  }
  if (summary && Array.isArray(summary.data)) {
    return summary.data;
  }
  return [];
}

function overtimeItem(payload) {
  return summaryList(payload).find((item) => item && (item.key === "OVERTIME" || item.name === "加班")) || null;
}

function displayValue(value) {
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

function clock(value) {
  const match = displayValue(value).match(/(\d{2}:\d{2})/);
  return match ? match[1] : "";
}

function dayLabel(value) {
  const match = displayValue(value).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return match[2] + "-" + match[3];
  }
  const text = displayValue(value);
  return text.length >= 10 ? text.slice(5, 10) : text;
}

function columnText(columns, row) {
  const hidden = /id$|name|job|dept|emp/i;
  const usable = (columns || []).filter((column) => {
    if (!column || !column.dataIndex || !column.title) {
      return false;
    }
    const index = String(column.dataIndex);
    const title = String(column.title);
    return !hidden.test(index) && !hidden.test(title);
  });
  const parts = [];
  usable.forEach((column) => {
    const value = displayValue(row[column.dataIndex]);
    if (!value || value.length > 80) {
      return;
    }
    parts.push(String(column.title) + " " + value);
  });
  return parts;
}

function overtimeDetail(row, index) {
  const start = displayValue(row.startTime);
  const end = displayValue(row.endTime);
  if (!start && !end) {
    return null;
  }
  const begin = clock(start);
  const finish = clock(end);
  const span = begin && finish ? begin + "–" + finish : (begin || finish);
  const total = displayValue(row.total);
  const amount = total ? (/天|小时|分钟/.test(total) ? total : total + " 天") : "";
  const dayType = displayValue(row.dayType);
  const lieu = displayValue(row.isLieuLeave) === "是" ? "已调休" : "";
  const text = [span, amount, dayType, lieu].filter(Boolean).join(" · ");
  if (!text) {
    return null;
  }
  return {
    id: start + "|" + end + "|" + index,
    date: dayLabel(start || end),
    sort: start || end,
    text
  };
}

function detailRows(payload) {
  const data = payload && (payload.data || payload);
  if (!data || typeof data !== "object") {
    return [];
  }
  const rows = [data.displayData, data.datas, data.list, data.records].find(Array.isArray) || [];
  const columns = Array.isArray(data.columns) ? data.columns : [];
  return rows.map((row, index) => {
    if (!row || typeof row !== "object") {
      return null;
    }
    const applied = Array.isArray(row.attendMsglink) && row.attendMsglink.some((link) =>
      link && link.linktype === "flow" && displayValue(link.flowid) && displayValue(link.linkname).startsWith("加班申请")
    );
    const overtime = overtimeDetail(row, index);
    if (overtime) {
      return { ...overtime, applied };
    }
    const parts = columnText(columns, row);
    const date = displayValue(row.attendDate || row.date || row.workDate || row.signDate);
    const text = parts.length ? parts.join(" · ") : [date, displayValue(row.length || row.duration || row.hour)].filter(Boolean).join(" · ");
    if (!text) {
      return null;
    }
    return {
      id: String(index),
      date: date ? date.slice(5) : "",
      sort: date || String(index),
      text,
      applied
    };
  }).filter(Boolean).sort((left, right) => String(left.sort).localeCompare(String(right.sort))).slice(0, 60).map((item) => ({
    id: item.id,
    date: item.date,
    text: item.text,
    applied: item.applied
  }));
}

function calendarDetails(payload) {
  const data = payload && payload.data || {};
  const extra = data.statusExtra && typeof data.statusExtra === "object" ? data.statusExtra : {};
  const events = Array.isArray(data.events) ? data.events : [];
  const rows = [];
  Object.keys(extra).sort().forEach((date) => {
    const statuses = Array.isArray(extra[date]) ? extra[date] : [extra[date]];
    if (!statuses.includes("OVERTIME")) {
      return;
    }
    rows.push({ id: date, date: String(date).slice(5), text: "加班" });
  });
  events.forEach((event, index) => {
    if (!event || (event.type !== "OVERTIME" && event.key !== "OVERTIME")) {
      return;
    }
    const when = displayValue(event.start || event.date || event.startStr || event.attendDate);
    const title = displayValue(event.title) || "加班";
    rows.push({
      id: "event-" + index,
      date: when ? String(when).slice(5, 10) : "",
      text: title
    });
  });
  return rows;
}

function normalizeAttendance(statis, detail, range, calendar) {
  const item = overtimeItem(statis);
  const rows = detailRows(detail);
  const days = rows.length ? rows : calendarDetails(calendar);
  const code = statis && (statis.code || statis.status);
  const rawMessage = statis && statis.msg;
  const failed = !statis || rawMessage === "not-json" || (code && Number(code) !== 200 && !item);
  return {
    state: failed ? "error" : "ready",
    message: failed ? ((statis && statis.msg) || "出勤统计没有返回") : "",
    monthKey: range.monthKey,
    totalText: item ? displayValue(item.value) : (rows.length ? "" : "0"),
    totalLabel: item && item.name ? item.name : "加班",
    details: days
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
    "  const body = { beginDate: " + begin + ", endDate: " + end + " };\n" +
    "  let statis = await post('/api/attend/web/attendInfoV2/getAttendInfoStatis', body, false);\n" +
    "  if (!statis || (statis.code && Number(statis.code) !== 200 && !(statis.data && statis.data.attendSummary))) {\n" +
    "    statis = await post('/api/app/attend/web/attendInfoV2/getAttendInfoStatis', body, false);\n" +
    "  }\n" +
    "  const detailBody = { type: 'OVERTIME', originBeginDate: " + begin + ", originEndDate: " + end + ", beginDate: " + begin + ", endDate: " + end + ", current: '1', pageSize: '100' };\n" +
    "  let detail = await post('/api/attend/web/attendInfoV2/getAttendInfoDetail', detailBody, false);\n" +
    "  if (!detail || Number(detail.code) === 500 || !(detail.data && (detail.data.displayData || detail.data.datas || detail.data.list))) {\n" +
    "    const again = await post('/api/attend/web/attendInfoV2/getAttendInfoDetail', detailBody, true);\n" +
    "    if (again && again.data) detail = again;\n" +
    "  }\n" +
    "  const calendar = await post('/api/attend/web/attendInfoV2/getCalendarList', body, false);\n" +
    "  return { statis: statis, detail: detail, calendar: calendar };\n" +
    "})()";
}

module.exports = {
  monthRange,
  normalizeAttendance,
  pageFetchExpression
};
