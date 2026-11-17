let current = null;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function totalText(attendance) {
  const value = attendance && attendance.totalText ? String(attendance.totalText) : "—";
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

function renderDetail(item) {
  const dateMatch = /^(\d{2})-(\d{2})$/.exec(String(item.date || ""));
  const date = dateMatch
    ? `<span class="detail-date" aria-label="${Number(dateMatch[1])}月${Number(dateMatch[2])}日"><span class="detail-date-day">${dateMatch[2]}</span><span class="detail-date-month">${Number(dateMatch[1])}月</span></span>`
    : `<span class="detail-date">${escapeHtml(item.date || "")}</span>`;
  const [period, ...notes] = String(item.text || "").split(" · ");
  const amount = /^\d+(?:\.\d+)?\s*(?:天|小时|分钟)$/.test(notes[0] || "") ? notes.shift() : "";
  const application = item.applied === true
    ? `<span class="application-badge" title="OA 出勤记录已关联加班申请">已申请</span>`
    : "";
  return `<li class="detail">
    ${date}
    <div class="detail-body">
      <div class="detail-heading">
        <span class="detail-period">${escapeHtml(period)}</span>
        ${amount ? `<span class="detail-amount">${escapeHtml(amount)}</span>` : ""}
      </div>
      <div class="detail-meta">
        ${notes.length ? `<span class="detail-note">${escapeHtml(notes.join(" · "))}</span>` : ""}
        ${application}
      </div>
    </div>
  </li>`;
}

function render() {
  const root = document.querySelector("#app");
  if (!current || !root) {
    return;
  }
  const attendance = current.attendance || {};
  const loading = attendance.state === "loading";
  const statusClass = attendance.state === "error" || attendance.state === "login" ? "status error" : "status";
  const details = attendance.details && attendance.details.length
    ? attendance.details.map(renderDetail).join("")
    : "";
  const month = /^(\d{4})-(\d{2})$/.exec(attendance.monthKey || "");
  const monthLabel = month ? `${month[1]} 年 ${Number(month[2])} 月` : "本月";
  document.querySelector("#oaStatus").textContent = current.oa?.message || "正在连接 OA";
  root.innerHTML = `
    <section class="summary" aria-label="月度加班汇总" aria-busy="${loading}">
      <div class="summary-heading">
        <p class="month">${escapeHtml(monthLabel)}</p>
        <button id="refreshAttendance" class="icon-button" type="button" title="刷新出勤统计" aria-label="刷新出勤统计" ${loading ? "disabled" : ""}><svg class="icon" aria-hidden="true"><use href="#i-refresh"/></svg></button>
      </div>
      <p class="summary-value">${escapeHtml(totalText(attendance))}</p>
      <p class="source">累计加班 · 来自 OA 出勤统计</p>
      ${attendance.message ? `<p class="${statusClass}" role="status">${escapeHtml(attendance.message)}</p>` : ""}
    </section>
    <section class="details-section" aria-label="加班明细">
      <div class="section-heading">
        <h2>加班明细</h2>
        ${details ? `<span class="count">${attendance.details.length} 条记录</span>` : ""}
      </div>
      ${details ? `<ul class="detail-list">${details}</ul>` : `<div class="empty-state"><svg class="icon" aria-hidden="true"><use href="#i-calendar"/></svg><p>${loading ? "正在读取出勤记录…" : attendance.state === "ready" ? "本月暂无加班明细" : "登录 OA 后刷新，查看每日明细"}</p></div>`}
    </section>
  `;
}

function applyState(state) {
  current = state;
  document.body.classList.toggle("collapsed", !state.panelOpen);
  render();
}

document.querySelector("#back").addEventListener("click", () => window.desk.goBack());
document.querySelector("#forward").addEventListener("click", () => window.desk.goForward());
document.querySelector("#reload").addEventListener("click", () => window.desk.reload());
document.querySelector("#home").addEventListener("click", () => window.desk.goHome());
document.querySelector("#edge").addEventListener("click", () => window.desk.togglePanel());
document.querySelector("#collapse").addEventListener("click", () => window.desk.togglePanel());
document.querySelector("#app").addEventListener("click", async (event) => {
  const button = event.target.closest("#refreshAttendance");
  if (!button || button.disabled) {
    return;
  }
  button.disabled = true;
  try {
    applyState(await window.desk.refreshAttendance());
  } catch (error) {
    current.attendance = { ...current.attendance, state: "error", message: "刷新失败，请稍后重试" };
    render();
  }
});

window.desk.getState().then(applyState);
window.desk.onState(applyState);
