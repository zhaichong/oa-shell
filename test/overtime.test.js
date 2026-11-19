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
