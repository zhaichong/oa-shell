const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCodexArgs, executionEnv } = require("../src/codex-runner");
const { normalizeAIConfig } = require("../src/ai-gateway");

test("Codex invocation uses process-only provider overrides and retains workspace sandbox", () => {
  const args = buildCodexArgs(normalizeAIConfig({ enabled: true, defaultModel: "test/model" }), "C:/isolated work");
  assert.equal(args.includes("--ignore-user-config"), true);
  assert.equal(args.includes("--ephemeral"), true);
  assert.equal(args[args.indexOf("--sandbox") + 1], "workspace-write");
  assert.equal(args[args.indexOf("--cd") + 1], "C:/isolated work");
  assert.equal(args.includes("--dangerously-bypass-approvals-and-sandbox"), false);
  assert.throws(() => buildCodexArgs(normalizeAIConfig({ enabled: true, defaultModel: "test/model", baseUrl: "https://remote.test/v1" }), "C:/isolated"), /本机/);
});

test("executor environment excludes vendor and task-system credentials", () => {
  process.env.OA_FIXTURE_SECRET = "never-forward";
  try {
    const environment = executionEnv();
    assert.equal(environment.OA_FIXTURE_SECRET, undefined);
    assert.equal(environment.OA_MAGPIE_KEY, "magpie-oa-shell");
  } finally { delete process.env.OA_FIXTURE_SECRET; }
});
