const test = require("node:test");
const assert = require("node:assert/strict");
const {
  expandDateRange,
  extractOvertimeDatesFromPayload,
  extractOvertimeDatesFromDocument
} = require("../src/overtime-flows");

test("extracts overtime date range from E10 form payload even when title uses today's date", () => {
  const payload = {
    code: 200,
    data: {
      formLayout: {
        pageLayouts: {
          comps: [
            { id: "f_apply_date", label: "申请时间" },
            { id: "f_start_date", label: "开始日期" },
            { id: "f_end_date", label: "结束日期" }
          ]
        }
      },
      formData: {
        dataDetails: {
          requestName: "加班申请-翟冲-2026-11-18 - 直属上级审批",
          requestMark: "YHJBSQ202611184698",
          f_apply_date: "2026-11-18",
          f_start_date: "2026-11-17",
          f_end_date: "2026-11-17"
        }
      }
    }
  };
  const extracted = extractOvertimeDatesFromPayload(payload, "/api/workflow/core/form/core/getFormDataAndLayout");
  assert.ok(extracted);
  assert.deepEqual(extracted.dates, ["2026-11-17"]);
  assert.equal(extracted.flowNo, "YHJBSQ202611184698");
});

test("ignores non-overtime workflows and withdrawn drafts", () => {
  const nonOvertime = extractOvertimeDatesFromPayload({
    data: { requestName: "请假申请-2026-11-18", beginDate: "2026-11-17" }
  }, "/api/workflow/list");
  assert.equal(nonOvertime, null);

  const withdrawn = extractOvertimeDatesFromPayload({
    data: { requestName: "加班申请-2026-11-18", status: "已撤销", beginDate: "2026-11-17" }
  }, "/api/workflow/list");
  assert.equal(withdrawn, null);
});

test("extracts overtime dates from rendered submitted OA form DOM", () => {
  const doc = {
    body: {
      innerText: [
        "加班申请-翟冲-2026-11-18 - 直属上级审批",
        "强制收回 催办 更多",
        "基本信息",
        "申请时间 2026-11-18 流程编号 YHJBSQ202611184698",
        "加班信息",
        "开始日期 2026-11-17 结束日期 2026-11-17",
        "开始时间 17:30 结束时间 20:00"
      ].join("\n")
    }
  };
  const result = extractOvertimeDatesFromDocument(doc);
  assert.ok(result);
  assert.deepEqual(result.dates, ["2026-11-17"]);
  assert.equal(result.flowNo, "YHJBSQ202611184698");
  assert.equal(result.period, "17:30–20:00");
  assert.deepEqual(expandDateRange("2026-11-17", "2026-11-19"), ["2026-11-17", "2026-11-18", "2026-11-19"]);
});

test("reads the worked interval even when E10 wraps its labels across lines", () => {
  const body = { innerText: "加班申请 2026-11-18 流程编号 YHJBSQ202611184698\n加班信息\n开始\n日期 2026-11-17 结束\n日期 2026-11-17\n开始\n时间 17:30 结束\n时间 20:00" };
  const result = extractOvertimeDatesFromDocument({ body });
  assert.deepEqual(result.dates, ["2026-11-17"]);
  assert.equal(result.period, "17:30–20:00");
  body.innerText = "申请时间 2026-11-18 加班申请 YHJBSQ202611184698 加班信息 开始时间 17:30 结束时间 20:00";
  assert.equal(extractOvertimeDatesFromDocument({ body }), null);
});

test("an overnight request ending at midnight does not claim the following punch day", () => {
  const result = extractOvertimeDatesFromPayload({ requestName: "加班申请", requestMark: "YHJBSQ99",
    startDate: "2026-11-17", startTime: "21:00", endDate: "2026-11-18", endTime: "00:00" }, "/api/workflow");
  assert.deepEqual(result.dates, ["2026-11-17"]);
  assert.equal(result.period, "2026-11-17 21:00–2026-11-18 00:00");
});
