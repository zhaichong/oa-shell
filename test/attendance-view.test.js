const test = require("node:test");
const assert = require("node:assert/strict");
test("keeps OA units and splits an overtime row", async () => {
  const view = await import("../src/renderer/src/attendance-view.mjs");
  assert.equal(view.totalText({ totalText: "1.5 天", totalLabel: "加班" }), "1.5 天");
  assert.equal(view.totalText({ state: "login", totalText: "0", totalLabel: "加班" }), "—");
  assert.equal(view.totalText({ totalText: "1.5", totalLabel: "加班天数" }), "1.5 天");
  assert.equal(view.monthLabel("2026-11"), "2026 年 11 月");
  assert.deepEqual(view.splitDetail("18:00–20:15 · 2 小时 15 分钟"), {
    period: "18:00–20:15",
    amount: "2 小时 15 分钟",
    notes: ""
  });
  assert.deepEqual(view.splitDetail("17:30–20:00 · 0.25 天 · 工作日"), {
    period: "17:30–20:00",
    amount: "0.25 天",
    notes: "工作日"
  });
  assert.equal(view.dateParts("11-03").ariaLabel, "11月3日");
  assert.equal(view.emptyDetailMessage({ state: "ready", details: [] }), "本月暂无加班明细");
});
