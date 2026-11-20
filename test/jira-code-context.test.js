const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { findJiraCodeCandidates, readJiraCodeContext } = require("../src/jira-code-context");

test("reads only selected tracked text from the requested commit", async context => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "oa-jira-code-"));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: repository, stdio: "pipe" });
  git("init", "-q");
  fs.writeFileSync(path.join(repository, "app.js"), "const value = 1;\n");
  fs.writeFileSync(path.join(repository, "private.js"), "another file");
  git("add", "--", "app.js", "private.js");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + path.join(repository, ".git", "no-hooks"), "commit", "-qm", "fixture");
  fs.writeFileSync(path.join(repository, "app.js"), "uncommitted text");
  const read = files => readJiraCodeContext({ repository, branch: "HEAD", files });
  const baseline = await read(["app.js"]);
  assert.match(baseline.commit, /^[a-f0-9]{40,64}$/);
  assert.deepEqual(baseline.sources.map(file => [file.path, file.content.trim()]), [["app.js", "const value = 1;"]]);
  assert.equal(fs.readFileSync(path.join(repository, "app.js"), "utf8"), "uncommitted text");
  await assert.rejects(read(["../private.js"]), /相对/);
  await assert.rejects(read([".env.local"]), /凭证/);
  await assert.rejects(read(["missing.js"]), /不可读取/);
  await assert.rejects(readJiraCodeContext({ repository, branch: "--help", files: ["app.js"] }), /基准分支/);
});

test("finds relevant paths locally and sends only confirmed files from the pinned commit", async context => {
  const { createAIService } = require("../src/ai-gateway");
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "oa-jira-discovery-"));
  context.after(() => fs.rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: repository, stdio: "pipe" });
  const write = (filename, content) => {
    const target = path.join(repository, filename);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  };
  const commit = () => git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + path.join(repository, ".git", "no-hooks"), "commit", "-qm", "fixture");
  git("init", "-q");
  write("src/CheckoutButton.vue", "export const checkout = 'first-version';");
  write("src/CheckoutDialog.vue", "export default {};");
  write("src/validation.js", "throw new Error('CHECKOUT_BAD_STATE');");
  write("src/manual.js", "export const supplemental = true;");
  write("src/credentials.js", "CHECKOUT_BAD_STATE");
  write("dist/CheckoutButton.vue", "CHECKOUT_BAD_STATE");
  write("src/invalid.vue", Buffer.from([255, 0, 255]));
  write("src/large.js", "x".repeat(11000));
  git("add", "--", ".");
  commit();
  write("src/untracked.js", "CHECKOUT_BAD_STATE");
  const issue = { key: "DEMO-42", title: "CheckoutDialog CHECKOUT_BAD_STATE",
    description: "见 src/CheckoutButton.vue，以及 src/invalid.vue" };
  const requestBase = { repository, branch: "HEAD" };
  const payloads = [];
  const config = { enabled: true, baseUrl: "https://example.test/v1", auth: "none", protocol: "chat",
    analysisModel: "fixture/grok", timeoutSeconds: 5, outputLimit: 512 };
  const service = createAIService({ resolve: async () => ({ config, apiKey: "" }) }, async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return Response.json({ choices: [{ message: { content: "检查 CheckoutButton" } }] });
  });
  const found = await findJiraCodeCandidates({ ...requestBase, ...issue });
  assert.equal(payloads.length, 0);
  assert.deepEqual(found.candidates.map(item => [item.path, item.selected]), [
    ["src/CheckoutButton.vue", true], ["src/CheckoutDialog.vue", true], ["src/validation.js", false]
  ]);
  assert.ok(found.candidates.every(item => item.reason && !("content" in item)));
  write("src/CheckoutButton.vue", "export const checkout = 'new-version';");
  git("add", "--", "src/CheckoutButton.vue");
  commit();
  const code = await readJiraCodeContext({ ...requestBase, commit: found.commit, files: ["src/CheckoutButton.vue", "src/manual.js"] });
  assert.notEqual(found.commit, git("rev-parse", "HEAD").toString().trim());
  await service.ask({ text: JSON.stringify({ issue, code }) });
  const sent = JSON.parse(payloads[0].messages.at(-1).content);
  assert.equal(sent.issue.key, issue.key);
  assert.deepEqual(sent.code.sources.map(file => file.path), ["src/CheckoutButton.vue", "src/manual.js"]);
  assert.match(sent.code.sources[0].content, /first-version/);
  assert.deepEqual((await findJiraCodeCandidates({ ...requestBase, title: "UNIQUE_UNMATCHED_WORD" })).candidates, []);
  await assert.rejects(findJiraCodeCandidates({ ...requestBase, branch: "no-such-branch" }), /基准分支/);
  await assert.rejects(readJiraCodeContext({ ...requestBase, files: ["src/large.js"] }), /超过分析上限/);
});
