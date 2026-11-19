function normalizeDateKey(value) {
  const match = typeof value === "string" ? value.match(/(\d{4})-(\d{2})-(\d{2})/) : null;
  if (!match) {
    return "";
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return "";
  }
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) {
    return "";
  }
  return match[1] + "-" + match[2] + "-" + match[3];
}

function expandDateRange(startValue, endValue) {
  const startKey = normalizeDateKey(startValue);
  const endKey = normalizeDateKey(endValue) || startKey;
  if (!startKey) {
    return [];
  }
  const [sy, sm, sd] = startKey.split("-").map(Number);
  const [ey, em, ed] = endKey.split("-").map(Number);
  const start = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  if (end < start) {
    return [startKey];
  }
  const results = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end && results.length < 31) {
    results.push(
      cursor.getFullYear() + "-" +
      String(cursor.getMonth() + 1).padStart(2, "0") + "-" +
      String(cursor.getDate()).padStart(2, "0")
    );
    cursor.setDate(cursor.getDate() + 1);
  }
  return results;
}

function formValue(raw) {
  if (typeof raw === "string") return raw.trim();
  if (!raw || typeof raw !== "object") return "";
  return [raw.value, raw.displayValue, raw.text].find(value => typeof value === "string" && value.trim()) || "";
}

function workPeriod(fields) {
  const start = normalizeDateKey(fields.startDate) || normalizeDateKey(fields.startTime);
  const end = normalizeDateKey(fields.endDate) || normalizeDateKey(fields.endTime) || start;
  if (!start || end < start) return null;
  const readClock = value => {
    const match = String(value || "").match(/(?:^|[T\s])([01]?\d|2[0-3]):([0-5]\d)(?::\d\d)?(?:$|\s)/);
    return match ? match[1].padStart(2, "0") + ":" + match[2] : "";
  };
  const from = readClock(fields.startTime || fields.startDate);
  const to = readClock(fields.endTime || fields.endDate);
  const hasTimes = Boolean(from && to);
  if (hasTimes && start === end && to <= from) return null;
  const dates = expandDateRange(start, end);
  if (hasTimes && start !== end && to === "00:00" && dates.at(-1) === end) dates.pop();
  const period = hasTimes ? (start === end ? from + "–" + to : start + " " + from + "–" + end + " " + to) : "";
  return { dates, period };
}

const fieldNames = new Map(Object.entries({
  "开始日期": "startDate", "加班日期": "startDate", "结束日期": "endDate",
  "开始时间": "startTime", "结束时间": "endTime",
  startdate: "startDate", begindate: "startDate", overtimedate: "startDate", workdate: "startDate", attenddate: "startDate",
  enddate: "endDate", starttime: "startTime", begintime: "startTime", endtime: "endTime",
  ksrq: "startDate", jsrq: "endDate", kssj: "startTime", jssj: "endTime", jbrq: "startDate"
}));

function fieldName(label) {
  return fieldNames.get(String(label || "").replace(/[\s：:*]/g, "").toLowerCase());
}

function extractOvertimeRecords(payload, url) {
  if (!payload || typeof payload !== "object" || (url && !/workflow|ebuilder|attend|overtime|flow|form/i.test(url))) return [];
  const aliases = new Map();
  const results = [];
  function children(node) {
    return Object.values(node).filter(value => value && typeof value === "object");
  }
  function mapLabels(node, depth) {
    if (depth > 15) return;
    const label = node.fieldLabel || node.label || node.title || node.name;
    if (typeof label === "string") {
      for (const id of [node.fieldId, node.colName, node.dataKey, node.fieldName, node.id]) {
        if (id != null && fieldName(label)) aliases.set(String(id), label);
      }
    }
    children(node).forEach(child => mapLabels(child, depth + 1));
  }
  mapLabels(payload, 0);
  function visit(node, context, depth) {
    if (depth > 15) return;
    const title = formValue(node.requestName || node.linkname || node.flowName || node.title || node.name);
    const mark = formValue(node.requestMark || node.flowCode || node.serialNumber || node.billCode);
    if (/退回|撤销|作废|删除|草稿/.test(formValue(node.statusName || node.status || node.currentNodeName))) return;
    if (/加班申请|YHJBSQ/i.test(title + " " + mark)) {
      context = { title: title || "加班申请", flowNo: ((mark + " " + title).match(/YHJBSQ\d+/i) || [""])[0] };
    } else if (node.requestName || node.flowName) {
      return;
    }
    if (context && !Array.isArray(node)) {
      const fields = {};
      for (const [key, value] of Object.entries(node)) {
        const name = fieldName(aliases.get(key) || key);
        if (name) fields[name] = formValue(value);
      }
      const range = workPeriod(fields);
      if (range) results.push({ ...context, ...range });
    }
    for (const [key, child] of Object.entries(node)) {
      if (key !== "formLayout" && child && typeof child === "object") visit(child, context, depth + 1);
    }
  }
  visit(payload, null, 0);
  // In E10 a single form's request header can be a sibling of its field values.
  const form = payload.data?.formData || payload.formData;
  if (!results.length && form && !Array.isArray(form)) {
    const header = payload.data?.requestInfo || payload.requestInfo || {};
    const encoded = JSON.stringify(form);
    const mark = (encoded.match(/"((?:YHJBSQ)\d+)"/) || [])[1] || header.requestMark;
    if (/^YHJBSQ\d+$/.test(mark || "") && !/退回|撤销|作废|删除|草稿/.test(header.statusName || header.status || "")) {
      visit(form, { title: "加班申请", flowNo: mark }, 0);
    }
  }
  return results;
}

function extractOvertimeDatesFromPayload(payload, url) {
  return extractOvertimeRecords(payload, url)[0] || null;
}

function extractOvertimeDatesFromSingleDoc(doc) {
  if (!doc || !doc.body) return null;
  const text = String(doc.body.innerText || doc.body.textContent || "");
  const flow = text.match(/YHJBSQ\d+/i);
  const heading = /加\s*班\s*信\s*息/.exec(text);
  if (!heading || !(/加班申请/.test(text) || flow) || !(flow || /强制收回|催办/.test(text))) return null;
  if (/当前状态[:：\s]*(?:草稿|已撤销|已作废|已退回)/.test(text)) return null;
  const section = text.slice(heading.index + heading[0].length).split(/加\s*班\s*事\s*由|审批意见/)[0];
  const fields = {};
  for (const match of section.matchAll(/(开\s*始|结\s*束|加\s*班)\s*(日\s*期|时\s*间)[\s:*：]*(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?|\d{1,2}:\d{2})/g)) {
    fields[fieldName(match[1] + match[2])] = match[3];
  }
  // Editable E10 table cells keep their displayed date or time in the control value.
  if (doc.querySelectorAll && !(fields.startDate && fields.endDate && fields.startTime && fields.endTime)) {
    const walker = doc.createTreeWalker(doc.body, 4); // SHOW_TEXT
    let sectionStart = null;
    let sectionEnd = null;
    while (walker.nextNode()) {
      const label = walker.currentNode.textContent.replace(/\s/g, "");
      if (!sectionStart && label === "加班信息") sectionStart = walker.currentNode;
      else if (sectionStart && /^(加班事由|审批意见)$/.test(label)) {
        sectionEnd = walker.currentNode;
        break;
      }
    }
    for (const input of doc.querySelectorAll("input,select")) {
      if (!sectionStart || !(sectionStart.compareDocumentPosition(input) & 4)) continue;
      if (sectionEnd && !(input.compareDocumentPosition(sectionEnd) & 4)) continue;
      const cell = input.closest("td,[role=cell]");
      const group = input.closest("label,.form-item,.ant-form-item,.weapp-form-item");
      const label = (cell?.previousElementSibling?.textContent || group?.querySelector("label")?.textContent || input.getAttribute("aria-label"));
      const key = fieldName(label);
      if (key && !fields[key] && input.value) fields[key] = input.value;
    }
  }
  const range = workPeriod(fields);
  return range && { ...range, flowNo: flow ? flow[0] : "", title: "加班申请" };
}

function extractOvertimeDatesFromDocument(doc) {
  const direct = extractOvertimeDatesFromSingleDoc(doc);
  if (direct) {
    return direct;
  }
  if (!doc || typeof doc.querySelectorAll !== "function") {
    return null;
  }
  const frames = doc.querySelectorAll("iframe");
  for (let i = 0; i < frames.length; i += 1) {
    try {
      const childDoc = frames[i] && frames[i].contentDocument;
      const nested = extractOvertimeDatesFromSingleDoc(childDoc);
      if (nested) {
        return nested;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function installOvertimeFlowMonitor(win, onDetected) {
  if (!win || typeof onDetected !== "function" || win.__oaOvertimeMonitorInstalled) {
    return;
  }
  win.__oaOvertimeMonitorInstalled = true;
  let lastKey = "";

  function emit(result) {
    if (!result || !Array.isArray(result.dates) || !result.dates.length) {
      return;
    }
    const key = result.dates.join(",") + "|" + String(result.flowNo || "") + "|" + (result.period || "");
    if (key === lastKey) {
      return;
    }
    lastKey = key;
    try {
      onDetected(result);
    } catch {
      return;
    }
  }

  function inspectText(text, url) {
    if (typeof text !== "string" || text.length < 10 || text.length > 2 * 1024 * 1024) {
      return;
    }
    if (!/加班|YHJBSQ/i.test(text)) {
      return;
    }
    try {
      const parsed = JSON.parse(text);
      extractOvertimeRecords(parsed, url).forEach(emit);
    } catch {
      return;
    }
  }

  function isWatchedUrl(url) {
    try {
      const target = new URL(String(url || ""), win.location.href);
      if (target.origin !== win.location.origin) {
        return false;
      }
      return /workflow|ebuilder|attend|overtime|flow|form/i.test(target.pathname);
    } catch {
      return false;
    }
  }

  if (win.XMLHttpRequest && win.XMLHttpRequest.prototype) {
    const proto = win.XMLHttpRequest.prototype;
    const origOpen = proto.open;
    const origSend = proto.send;
    proto.open = function (method, url) {
      this.__oaFlowUrl = typeof url === "string" ? url : "";
      this.__oaFlowMethod = typeof method === "string" ? method : "GET";
      return origOpen.apply(this, arguments);
    };
    proto.send = function () {
      if (isWatchedUrl(this.__oaFlowUrl) && typeof this.addEventListener === "function") {
        const xhr = this;
        xhr.addEventListener("load", function () {
          try {
            if (xhr.responseType === "" || xhr.responseType === "text") {
              inspectText(xhr.responseText, xhr.__oaFlowUrl);
            } else if (xhr.responseType === "json" && xhr.response && typeof xhr.response === "object") {
              extractOvertimeRecords(xhr.response, xhr.__oaFlowUrl).forEach(emit);
            }
          } catch {
            return;
          }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  if (typeof win.fetch === "function") {
    const origFetch = win.fetch;
    win.fetch = function (input) {
      const url = typeof input === "string" ? input : (input && input.url) || "";
      const promise = origFetch.apply(this, arguments);
      if (!isWatchedUrl(url)) {
        return promise;
      }
      return promise.then((response) => {
        try {
          if (response && typeof response.clone === "function") {
            response.clone().text().then((text) => inspectText(text, url)).catch(() => {});
          }
        } catch {
          return response;
        }
        return response;
      });
    };
  }

  const doc = win.document;
  if (doc && typeof win.MutationObserver === "function") {
    let domTimer = null;
    const scan = () => {
      domTimer = null;
      emit(extractOvertimeDatesFromSingleDoc(doc));
      for (const frame of doc.querySelectorAll("iframe")) {
        try {
          if (frame.contentDocument?.body) installOvertimeFlowMonitor(frame.contentWindow, onDetected);
        } catch {
          // Cross-origin frames cannot supply OA form fields.
        }
      }
    };
    const scheduleScan = () => {
      if (domTimer !== null) {
        return;
      }
      domTimer = win.setTimeout(scan, 450);
    };
    const startObserver = () => {
      if (!doc.body) {
        return;
      }
      const observer = new win.MutationObserver(scheduleScan);
      observer.observe(doc.body, { childList: true, characterData: true, subtree: true });
      doc.addEventListener("load", event => {
        if (event.target?.tagName === "IFRAME") scheduleScan();
      }, true);
      scheduleScan();
    };
    if (doc.readyState === "loading") {
      doc.addEventListener("DOMContentLoaded", startObserver, { once: true });
    } else {
      startObserver();
    }
  }
}

module.exports = {
  workPeriod,
  normalizeDateKey,
  expandDateRange,
  extractOvertimeDatesFromPayload,
  extractOvertimeDatesFromDocument,
  installOvertimeFlowMonitor
};
