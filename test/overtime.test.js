const test = require("node:test");
const assert = require("node:assert/strict");
const { buildSnapshot, collectReminders, formatMinutes, normalizeData } = require("../src/overtime");

const settings = {
  oaUrl: "https://oa.yarward.com:35877/",
  workStart: "09:00",
  workEnd: "18:00",
  overtimeRemindMinutes: 60,
  missedCheckInMinutes: 15,
  missedApplicationTime: "21:00",
  workdays: [1, 2, 3, 4, 5]
};

function at(hour, minute) {
  return new Date(2026, 10, 17, hour, minute, 0);
}

test("counts time after the configured end", () => {
  const snapshot = buildSnapshot({
    settings,
    days: {
      "2026-11-17": { checkIn: "09:06", checkOut: "20:15", applied: false }
    }
  }, at(20, 15));
  assert.equal(snapshot.today.overtimeMinutes, 135);
  assert.equal(snapshot.today.provisional, false);
  assert.equal(formatMinutes(snapshot.today.overtimeMinutes), "2 小时 15 分钟");
});

test("uses the current time before checkout", () => {
  const snapshot = buildSnapshot({
    settings,
    days: {
      "2026-11-17": { checkIn: "08:58", checkOut: "", applied: false }
    }
  }, at(18, 40));
  assert.equal(snapshot.today.overtimeMinutes, 40);
  assert.equal(snapshot.today.provisional, true);
});

test("does not turn a missing past checkout into overnight overtime", () => {
  const snapshot = buildSnapshot({
    settings,
    days: {
      "2026-11-16": { checkIn: "09:00", checkOut: "", applied: false }
    }
  }, at(19, 0));
  assert.equal(snapshot.month.days[0].missingCheckOut, true);
  assert.equal(snapshot.month.days[0].overtimeMinutes, 0);
});

test("sums only the current month and separates unapplied time", () => {
  const snapshot = buildSnapshot({
    settings,
    days: {
      "2026-10-31": { checkIn: "09:00", checkOut: "21:00", applied: false },
      "2026-11-16": { checkIn: "09:00", checkOut: "19:00", applied: true },
      "2026-11-17": { checkIn: "09:00", checkOut: "20:00", applied: false }
    }
  }, at(20, 0));
  assert.equal(snapshot.month.totalMinutes, 180);
  assert.equal(snapshot.month.unappliedMinutes, 120);
});

test("reminds for missing check-in, overtime, and a missing application", () => {
  const early = collectReminders({ settings, days: {}, reminders: {} }, at(9, 20));
  assert.deepEqual(early.map((item) => item.id), ["missedCheckIn"]);

  const overtime = collectReminders({
    settings,
    days: { "2026-11-17": { checkIn: "09:00", checkOut: "", applied: false } },
    reminders: {}
  }, at(19, 10));
  assert.deepEqual(overtime.map((item) => item.id), ["overtime"]);

  const application = collectReminders({
    settings,
    days: { "2026-11-17": { checkIn: "09:00", checkOut: "21:30", applied: false } },
    reminders: { "2026-11-17": { overtime: true } }
  }, at(21, 30));
  assert.deepEqual(application.map((item) => item.id), ["missedApplication"]);
});

test("does not repeat a reminder or fire it after the request is marked", () => {
  const data = {
    settings,
    days: { "2026-11-17": { checkIn: "09:00", checkOut: "20:00", applied: true } },
    reminders: {}
  };
  assert.equal(collectReminders(data, at(21, 30)).length, 0);
  data.days["2026-11-17"].applied = false;
  data.reminders["2026-11-17"] = { overtime: true, missedApplication: true };
  assert.equal(collectReminders(data, at(21, 30)).length, 0);
});

test("reminds about yesterday's missing checkout", () => {
  const reminders = collectReminders({
    settings,
    days: { "2026-11-16": { checkIn: "09:00", checkOut: "" } },
    reminders: {}
  }, at(9, 0));
  assert.equal(reminders[0].id, "missedCheckOut");
  assert.equal(reminders[0].dateKey, "2026-11-16");
});


test("uses the EMobile message page instead of the portal home", () => {
  const data = normalizeData({
    settings: { oaUrl: "https://oa.yarward.com:35877/" }
  });
  assert.equal(data.settings.oaUrl, "https://oa.yarward.com:35877/sp/em/main");
});
