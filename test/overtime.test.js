const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeData } = require("../src/overtime");

test("normalizes a saved OA portal URL for backward compatibility", () => {
  const data = normalizeData({
    settings: { oaUrl: "https://oa.yarward.com:35877/" }
  });
  assert.equal(data.settings.oaUrl, "https://oa.yarward.com:35877/sp/em/main");
});

test("keeps legacy applied days and reminder flags when loading local data", () => {
  const date = "2026-11-17";
  const data = normalizeData({
    days: { [date]: { checkIn: "09:00:12", applied: true } },
    reminders: { [date]: { overtime: true } }
  });
  assert.equal(data.days[date].checkIn, "09:00");
  assert.equal(data.days[date].applied, true);
  assert.equal(data.reminders[date].overtime, true);
});

test("accepts single-digit hours like 9:00 and stores them padded", () => {
  const data = normalizeData({
    settings: { workStart: "9:00", workEnd: "18:00", overtimeStart: "19:00" },
    tasks: [{ id: "abcdefgh", at: "9:00", dateKey: "2026-11-17", text: "提交加班" }]
  });
  assert.equal(data.settings.workStart, "09:00");
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].at, "09:00");
  const invalid = normalizeData({ settings: { workStart: "24:00" } });
  assert.equal(invalid.settings.workStart, "09:00");
});

test("the submitted-dates cap keeps the newest 200 entries", () => {
  const submitted = {};
  const start = new Date(2026, 0, 1);
  for (let i = 0; i < 210; i += 1) {
    const day = new Date(start.getTime());
    day.setDate(day.getDate() + i);
    const key = day.getFullYear() + "-" + String(day.getMonth() + 1).padStart(2, "0") + "-" + String(day.getDate()).padStart(2, "0");
    submitted[key] = { flowNo: "F" + i, title: "加班申请", at: "2026-01-01T00:00:00.000Z" };
  }
  const data = normalizeData({ submittedOvertimeDates: submitted });
  const keys = Object.keys(data.submittedOvertimeDates);
  assert.equal(keys.length, 200);
  assert.equal(data.submittedOvertimeDates["2026-01-01"], undefined);
  assert.equal(data.submittedOvertimeDates["2026-07-29"].flowNo, "F209");
});

test("empty reminder minutes fall back to the default instead of 0", () => {
  assert.equal(normalizeData({ settings: { overtimeRemindMinutes: "" } }).settings.overtimeRemindMinutes, 60);
  assert.equal(normalizeData({ settings: { overtimeRemindMinutes: null } }).settings.overtimeRemindMinutes, 60);
  assert.equal(normalizeData({ settings: { overtimeRemindMinutes: 0 } }).settings.overtimeRemindMinutes, 0);
});

test("clock settings tolerate surrounding whitespace", () => {
  assert.equal(normalizeData({ settings: { workStart: " 9:00" } }).settings.workStart, "09:00");
});

test("an empty workday list falls back to the default weekdays", () => {
  assert.deepEqual(normalizeData({ settings: { workdays: [] } }).settings.workdays, [1, 2, 3, 4, 5]);
});

test("the OA URL only accepts the company OA host", () => {
  assert.equal(
    normalizeData({ settings: { oaUrl: "https://example.com/sp/em/main" } }).settings.oaUrl,
    "https://oa.yarward.com:35877/sp/em/main"
  );
});
