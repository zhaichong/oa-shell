function dateParts(date) {
  const match = /^(\d{2})-(\d{2})$/.exec(String(date || ""));
  if (!match) {
    return null;
  }
  return {
    day: match[2],
    monthLabel: Number(match[1]) + "月",
    ariaLabel: Number(match[1]) + "月" + Number(match[2]) + "日"
  };
}

function monthLabel(monthKey) {
  const month = /^(\d{4})-(\d{2})$/.exec(monthKey || "");
  if (!month) {
    return "本月";
  }
  return month[1] + " 年 " + Number(month[2]) + " 月";
}

function totalText(attendance) {
  if (!attendance || attendance.state === "error" || attendance.state === "login") {
    return "—";
  }
  const value = attendance.totalText ? String(attendance.totalText) : "—";
  const label = attendance && attendance.totalLabel ? String(attendance.totalLabel) : "";
  if (/小时|分钟|天/.test(value)) {
    return value;
  }
  if (/天/.test(label) && /^\d+(?:\.\d+)?$/.test(value)) {
    return value + " 天";
  }
  if (/小时/.test(label) && /^\d+(?:\.\d+)?$/.test(value)) {
    return value + " 小时";
  }
  return value;
}

function splitDetail(text) {
  const [period, ...notes] = String(text || "").split(" · ");
  const amount = /^(?:\d+(?:\.\d+)?\s*(?:天|小时|分钟))(?:\s+\d+\s*分钟)?$/.test(notes[0] || "") ? notes.shift() || "" : "";
  return {
    period: period || "",
    amount,
    notes: notes.join(" · ")
  };
}

function emptyDetailMessage(attendance) {
  if (!attendance || attendance.state === "loading") {
    return "正在读取出勤记录…";
  }
  if (attendance.state === "ready") {
    return "本月暂无加班明细";
  }
  return "登录 OA 后刷新，查看每日明细";
}

export {
  dateParts,
  monthLabel,
  totalText,
  splitDetail,
  emptyDetailMessage
};
