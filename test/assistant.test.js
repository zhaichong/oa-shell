const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeData } = require("../src/overtime");
const {
  addReminder,
  cancelReminder,
  collectDueReminders,
  formatOvertime,
  helpText,
  parseCommand
} = require("../src/assistant");

function at(hour, minute) {
  return new Date(2026, 10, 17, hour, minute, 0);
}

test("parses the local assistant commands", () => {
  assert.equal(parseCommand("/加班").name, "overtime");
  assert.equal(parseCommand("/刷新").name, "refresh");
  assert.equal(parseCommand("/打开 工作消息").target, "messages");
  assert.equal(parseCommand("/打开 首页").target, "home");
  assert.deepEqual(parseCommand("/提醒 8:05 提交加班"), {
    ok: true,
    name: "remind",
    at: "08:05",
    text: "提交加班"
  });
  assert.equal(parseCommand("/取消 提交加班").name, "cancel");
  assert.equal(parseCommand("/帮助").name, "help");
  assert.match(helpText(), /\/加班/);
});

test("rejects commands that do not match the supported usage", () => {
  assert.equal(parseCommand("加班").ok, false);
  assert.equal(parseCommand("/加班 明天").ok, false);
  assert.equal(parseCommand("/打开 通讯录").ok, false);
  assert.equal(parseCommand("/提醒 25:00 提交加班").ok, false);
  assert.equal(parseCommand("/提醒 18:00").ok, false);
  assert.equal(parseCommand("/取消").ok, false);
  assert.match(parseCommand("/未知").message, /\/帮助/);
});

test("summarizes only attendance rows without an application", () => {
  const message = formatOvertime({
    state: "ready",
    totalText: "3 小时",
    details: [
      { date: "11-16", text: "18:00-19:00 · 1 小时", applied: true },
      { date: "11-17", text: "18:00-20:00 · 2 小时", applied: false }
    ]
  });
  assert.match(message, /3 小时/);
  assert.match(message, /待核对 1 条/);
  assert.match(message, /11-17/);
  assert.doesNotMatch(message, /11-16/);
});

test("stores one future reminder and cancels it by its text", () => {
  const created = addReminder([], at(17, 0), "18:00", "提交加班");
  assert.equal(created.ok, true);
  assert.equal(created.tasks.length, 1);
  assert.equal(addReminder(created.tasks, at(17, 10), "18:00", "提交加班").ok, false);
  assert.equal(addReminder([], at(18, 30), "18:00", "提交加班").ok, false);

  const cancelled = cancelReminder(created.tasks, "提交加班");
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.tasks[0].cancelled, true);
  assert.equal(collectDueReminders(cancelled.tasks, at(18, 5)).due.length, 0);
});

test("fires a due reminder once", () => {
  const created = addReminder([], at(17, 0), "18:00", "提交加班");
  const first = collectDueReminders(created.tasks, at(18, 0));
  const second = collectDueReminders(first.tasks, at(18, 10));
  assert.equal(first.due.length, 1);
  assert.equal(first.tasks[0].fired, true);
  assert.equal(second.due.length, 0);
});

test("asks for the full text when several reminders match", () => {
  const first = addReminder([], at(16, 0), "18:00", "提交加班申请");
  const second = addReminder(first.tasks, at(16, 0), "19:00", "提交加班说明");
  const result = cancelReminder(second.tasks, "加班");
  assert.equal(result.ok, false);
  assert.match(result.message, /完整内容/);
});

test("keeps assistant reminders when local data is normalized", () => {
  const data = normalizeData({
    tasks: [
      { id: "t202611171800abc", at: "18:00", text: "提交加班", dateKey: "2026-11-17" },
      { id: "bad id", at: "99:00", text: "", dateKey: "today" }
    ]
  });
  assert.equal(data.tasks.length, 1);
  assert.equal(data.tasks[0].text, "提交加班");
  assert.equal(data.tasks[0].fired, false);
});
