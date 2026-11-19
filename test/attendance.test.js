const test = require("node:test");

test("matches the form's actual work date even when the calendar links it on submission day", () => {
  const range = monthRange(new Date(2026, 10, 18));
  const state = normalizeAttendance({}, {}, range, [
    { date: "2026-11-17", clocks: ["20:17"] },
    { date: "2026-11-18", clocks: ["19:05"], flows: [{ requestId: 42, requestName: "加班申请-2026-11-18",
      startDate: { value: "2026-11-17" }, endDate: "2026-11-17", startTime: "17:30", endTime: "20:00" }] }
  ]);
  assert.equal(state.unappliedCount, 1);
  assert.equal(state.details[0].applied, true);
  assert.equal(state.details[0].applicationPeriod, "17:30–20:00");
  assert.match(state.details[0].text, /18:00–20:17/);
  assert.equal(state.details[1].applied, false);
});
const assert = require("node:assert/strict");
const { monthRange, normalizeAttendance, pageFetchExpression } = require("../src/attendance");

test("uses the calendar month containing the given day", () => {
  assert.deepEqual(monthRange(new Date(2026, 10, 17)), {
    monthKey: "2026-11",
    beginDate: "2026-11-01",
    endDate: "2026-11-30"
  });
});

test("counts a punch at 19:00 as one hour and ignores earlier punches", () => {
  const view = normalizeAttendance({
    code: 200,
    data: {
      attendSummary: {
        data: [
          { key: "OVERTIME", name: "加班(天)", value: "1.5" }
        ]
      }
    }
  }, { code: 200, data: { displayData: [] } }, monthRange(new Date(2026, 10, 17)), [
    { date: "2026-11-03", clocks: ["09:02", "18:59"] },
    { date: "2026-11-12", clocks: [{ signTime: { title: "上班打卡", value: "09:06" } }, { signTime: { title: "下班打卡", value: "19:00" } }] },
    { date: "2026-11-16", clocks: ["08:55", "20:15"] }
  ]);
  assert.equal(view.state, "ready");
  assert.equal(view.totalText, "3 小时 15 分钟");
  assert.equal(view.totalLabel, "加班");
  assert.deepEqual(view.details, [
    { id: "2026-11-12", date: "11-12", text: "18:00–19:00 · 1 小时", applied: false },
    { id: "2026-11-16", date: "11-16", text: "18:00–20:15 · 2 小时 15 分钟", applied: false }
  ]);
  assert.equal(JSON.stringify(view).includes("1.5"), false);
});

test("marks a punch day applied only when that date has an overtime request", () => {
  const view = normalizeAttendance({ code: 200, data: {} }, {
    code: 200,
    data: {
      displayData: [
        {
          startTime: "2026-11-12 18:00",
          attendMsglink: [{ linktype: "flow", linkname: "加班申请-测试-2026-11-12", flowid: "request-1" }]
        },
        {
          startTime: "2026-11-16 18:00",
          attendMsglink: [{ linktype: "flow", linkname: "调休申请-测试-2026-11-16", flowid: "request-2" }]
        },
        {
          startTime: "2026-11-17 18:00",
          attendMsglink: [{ linktype: "flow", linkname: "加班申请-测试-2026-11-17", flowid: "" }]
        }
      ]
    }
  }, monthRange(new Date(2026, 10, 17)), [
    { date: "2026-11-12", clocks: ["19:30"] },
    { date: "2026-11-16", clocks: ["21:00"] },
    { date: "2026-11-17", clocks: ["19:10"] }
  ]);
  assert.deepEqual(view.details.map((row) => [row.date, row.applied, row.text]), [
    ["11-12", true, "18:00–19:30 · 1 小时 30 分钟"],
    ["11-16", false, "18:00–21:00 · 3 小时"],
    ["11-17", false, "18:00–19:10 · 1 小时 10 分钟"]
  ]);
  assert.equal(JSON.stringify(view.details).includes("request-"), false);
});

test("keeps a failed attendance response as an error when no punches return", () => {
  const view = normalizeAttendance({ code: 401, msg: "not-json" }, null, monthRange(new Date(2026, 10, 17)), []);
  assert.equal(view.state, "error");
  assert.equal(view.details.length, 0);
});

test("loads each day's punch record instead of the overtime summary", () => {
  const source = pageFetchExpression(monthRange(new Date(2026, 10, 17)));
  assert.match(source, /getCalendarDetailByDate/);
  assert.match(source, /getAttendInfoDetail/);
  assert.doesNotMatch(source, /getCalendarList/);
});

test("treats pending overtime flows from punch calendar or detail rows as applied and tracks unappliedCount", () => {
  const range = monthRange(new Date(2026, 10, 17));
  const detail = {
    code: 0,
    data: {
      datas: []
    }
  };
  const punches = [
    {
      date: "2026-11-10",
      clocks: [{ signTime: "20:00:00", signType: 1 }],
      flows: [{ name: "加班申请流程", requestId: 9001, status: "审批中" }]
    },
    {
      date: "2026-11-11",
      clocks: [{ signTime: "19:30:00", signType: 1 }],
      flows: []
    }
  ];
  const result = normalizeAttendance({}, detail, range, punches);
  assert.equal(result.state, "ready");
  assert.equal(result.details.length, 2);
  assert.equal(result.details[0].applied, true);
  assert.equal(result.details[1].applied, false);
  assert.equal(result.unappliedCount, 1);

  const cleared = normalizeAttendance({}, detail, range, [
    punches[0],
    { ...punches[1], flows: [{ requestid: "9002", title: "加班申请-11月11日" }] }
  ]);
  assert.equal(cleared.details[1].applied, true);
  assert.equal(cleared.unappliedCount, 0);
});
