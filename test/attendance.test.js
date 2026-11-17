const test = require("node:test");
const assert = require("node:assert/strict");
const { monthRange, normalizeAttendance } = require("../src/attendance");

test("uses the calendar month containing the given day", () => {
  assert.deepEqual(monthRange(new Date(2026, 10, 17)), {
    monthKey: "2026-11",
    beginDate: "2026-11-01",
    endDate: "2026-11-30"
  });
});

test("reads this month overtime total and each attendance record", () => {
  const view = normalizeAttendance({
    code: 200,
    data: {
      attendSummary: {
        data: [
          { key: "LEAVE", name: "请假", value: "1.00" },
          { key: "OVERTIME", name: "加班(天)", value: "1.5" }
        ]
      }
    }
  }, {
    code: 200,
    data: {
      columns: [
        { title: "姓名", dataIndex: "empName" },
        { title: "工号", dataIndex: "jobNum" },
        { title: "开始时间", dataIndex: "startTime" }
      ],
      displayData: [
        {
          empName: "某人",
          jobNum: "0000",
          deptName: "部门",
          startTime: "2026-11-12 18:00",
          endTime: "2026-11-12 20:00",
          total: "0.25",
          dayType: "工作日",
          isLieuLeave: "否"
        },
        {
          empName: "某人",
          jobNum: "0000",
          startTime: "2026-11-03 17:30",
          endTime: "2026-11-03 19:30",
          total: "0.25",
          dayType: "工作日",
          isLieuLeave: "是"
        }
      ]
    }
  }, monthRange(new Date(2026, 10, 17)));
  assert.equal(view.state, "ready");
  assert.equal(view.totalText, "1.5");
  assert.equal(view.totalLabel, "加班(天)");
  assert.deepEqual(view.details, [
    { id: "2026-11-03 17:30|2026-11-03 19:30|1", date: "11-03", text: "17:30–19:30 · 0.25 天 · 工作日 · 已调休", applied: false },
    { id: "2026-11-12 18:00|2026-11-12 20:00|0", date: "11-12", text: "18:00–20:00 · 0.25 天 · 工作日", applied: false }
  ]);
  assert.equal(JSON.stringify(view.details).includes("0000"), false);
  assert.equal(JSON.stringify(view.details).includes("某人"), false);
});

test("marks only attendance records linked to an overtime application as applied", () => {
  const links = [
    [{ linktype: "flow", linkname: "加班申请-测试-2026-11-04", flowid: "request-1" }],
    [{ linktype: "flow", linkname: "调休申请-测试-2026-11-05", flowid: "request-2" }],
    [],
    null,
    [null, { linktype: "flow", linkname: "加班申请-测试-2026-11-08", flowid: "" }],
    [{ linktype: "flow", linkname: "调休申请", flowid: "request-3" }, { linktype: "flow", linkname: "加班申请", flowid: "request-4" }]
  ];
  const view = normalizeAttendance({ code: 200, data: {} }, {
    code: 200,
    data: {
      displayData: links.map((attendMsglink, index) => ({
        startTime: `2026-11-${String(index + 3).padStart(2, "0")} 17:30`,
        endTime: `2026-11-${String(index + 3).padStart(2, "0")} 19:30`,
        total: "0.25",
        attendMsglink
      }))
    }
  }, monthRange(new Date(2026, 10, 17)));
  assert.deepEqual(view.details.map(row => row.applied), [true, false, false, false, false, true]);
  assert.equal(JSON.stringify(view.details).includes("request-"), false);
});
