const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeConnection, createIntegrationStore, buildRequest, previewTasks, previewJiraBugs } = require("../src/integrations");

test("queries Jira defects with an enforced type, reporter, creation date and pagination", async () => {
  const config = normalizeConnection({ name: "Jira", kind: "jira-server", baseUrl: "https://example.test/jira/login.jsp",
    auth: "none", bugType: "缺陷", query: 'project = DEMO AND summary ~ "order by" ORDER BY updated ASC' });
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push(new URL(url));
    assert.equal(options.method, "GET");
    return Response.json({ total: 2, issues: [{ key: "DEMO-7", fields: {
      summary: "登录页提示异常", reporter: { displayName: "测试用户" },
      created: "2026-11-19T09:12:00.000+0800", description: {
        type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "复现步骤" }] }]
      }
    } }] });
  };
  const page = await previewJiraBugs(config, "", fetcher);
  assert.equal(requests[0].pathname, "/jira/rest/api/2/search");
  assert.equal(requests[0].searchParams.get("jql"), 'issuetype = "缺陷" AND (project = DEMO AND summary ~ "order by") ORDER BY created DESC, key DESC');
  assert.equal(requests[0].searchParams.get("fields"), "summary,status,reporter,created");
  assert.equal(page.items[0].reporter, "测试用户");
  assert.equal(page.items[0].created, "2026-11-19T09:12:00.000+0800");
  assert.deepEqual(page.next, { offset: 1 });
  await previewJiraBugs(config, "", fetcher, page.next);
  assert.equal(requests[1].searchParams.get("startAt"), "1");
  const detail = await previewJiraBugs(config, "", fetcher, { key: "demo-7" });
  assert.ok(requests[2].searchParams.get("jql").includes('key = "DEMO-7"'));
  assert.equal(detail.items[0].description, "复现步骤");
  assert.throws(() => previewJiraBugs(config, "", fetcher, { key: 'DEMO-7" OR' }), /Bug 号/);
});

test("Jira Cloud advances using its search cursor", async () => {
  const config = normalizeConnection({ name: "Cloud", kind: "jira-cloud", baseUrl: "https://example.test", auth: "none" });
  const page = await previewJiraBugs(config, "", async url => {
    assert.equal(new URL(url).searchParams.get("nextPageToken"), "page-token");
    return Response.json({ issues: [], isLast: true });
  }, { offset: 20, token: "page-token" });
  assert.equal(page.next, null);
});

test("interactive Jira filters support mine, escaped title text, and exact issue keys", async () => {
  const config = normalizeConnection({ name: "Jira", kind: "jira-server", baseUrl: "https://example.test", auth: "none",
    query: "assignee = currentUser() AND resolution = Unresolved" });
  const queries = [];
  const fetcher = async url => {
    const request = new URL(url);
    queries.push(request.searchParams.get("jql"));
    return Response.json({ total: 0, issues: [] });
  };
  await previewJiraBugs(config, "", fetcher, { filter: { mine: true, by: "title", value: "加载失败" } });
  assert.match(queries[0], /assignee = currentUser\(\).*summary ~/);
  await previewJiraBugs(config, "", fetcher, { filter: { mine: false, by: "key", value: " demo-42 " } });
  assert.equal(queries[1], 'issuetype = "Bug" AND (key = "DEMO-42") ORDER BY created DESC, key DESC');
  await previewJiraBugs(config, "", fetcher, { filter: { mine: false, by: "title", value: 'x" OR project = SECRET' } });
  assert.ok(queries[2].includes('summary ~ '));
  assert.ok(queries[2].includes('\\"'));
  assert.doesNotMatch(queries[2], /currentUser/);
  assert.throws(() => previewJiraBugs(config, "", fetcher, { filter: { mine: false, by: "key", value: "42" } }), /Bug 号/);
});

function config(patch = {}) {
  return { name: "Test Jira", kind: "jira-server", baseUrl: "https://jira.example.test/team", auth: "bearer", mappings: {}, ...patch };
}

function fixture(context, crypto = { encrypt: async value => Buffer.from(value).reverse(), decrypt: async value => Buffer.from(value).reverse().toString() }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "oa-integrations-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "integrations.json");
  return { file, store: createIntegrationStore(file, crypto) };
}

test("normalizes Jira login URL without hardcoding host and requires HTTP opt-in", () => {
  assert.throws(() => normalizeConnection(config({ baseUrl: "http://intranet.test/login.jsp" })), /HTTP/);
  assert.equal(normalizeConnection(config({ baseUrl: "http://intranet.test/jira/login.jsp", allowHttp: true })).baseUrl, "http://intranet.test/jira");
  for (const patch of [
    { baseUrl: "https://user:password@example.test" },
    { endpoint: "//other.test/tasks" },
    { endpoint: "/tasks?token=secret" },
    { headerName: "Host" },
    { endpoint: "/\\other.test/tasks" }
  ]) assert.throws(() => normalizeConnection(config(patch)));
});

test("stores ciphertext, never returns credentials, preserves blank edits and prevents credential forwarding to a new host", async context => {
  const { store, file } = fixture(context);
  const saved = await store.save(config({ secret: "private-token-123" }));
  assert.equal(saved.secretConfigured, true);
  assert.equal(JSON.stringify(saved).includes("private-token-123"), false);
  assert.equal(fs.readFileSync(file, "utf8").includes("private-token-123"), false);
  await store.save({ ...saved, name: "Renamed", secret: "" });
  assert.equal((await store.resolve(saved.id)).secret, "private-token-123");
  await assert.rejects(store.save({ ...saved, baseUrl: "https://other.test", secret: "" }), /重新填写/);
  assert.equal((await store.resolve(saved.id)).config.name, "Renamed");
  await store.remove(saved.id);
  assert.equal(store.list().length, 0);
});

test("encryption failure and corrupted storage do not overwrite saved configuration", async context => {
  const { store, file } = fixture(context, { encrypt: async () => { throw new Error("locked"); } });
  await assert.rejects(store.save(config({ secret: "private" })), /locked/);
  assert.equal(fs.existsSync(file), false);
  fs.writeFileSync(file, "broken-original");
  await assert.rejects(store.save(config({ auth: "none" })), /未覆盖/);
  assert.equal(fs.readFileSync(file, "utf8"), "broken-original");
});

test("concurrent saves preserve multiple systems and browser authentication needs no extracted secret", async context => {
  const { store } = fixture(context);
  await Promise.all([store.save(config({ name: "One", auth: "browser" })), store.save(config({ name: "Two", auth: "none" }))]);
  assert.equal(store.list().length, 2);
  assert.equal((await store.resolve(store.list()[0].id)).secret, "");
});

test("Jira cloud and server requests preserve deployment prefixes, JQL and authentication", () => {
  const server = buildRequest(normalizeConnection(config({ auth: "basic", username: "user", query: "project = DEMO" })), "password");
  const url = new URL(server.url);
  assert.equal(url.pathname, "/team/rest/api/2/search");
  assert.equal(url.searchParams.get("jql"), "project = DEMO");
  assert.equal(server.headers.Authorization, "Basic " + Buffer.from("user:password").toString("base64"));
  const cloud = buildRequest(normalizeConnection(config({ kind: "jira-cloud" })), "token");
  assert.equal(new URL(cloud.url).pathname, "/team/rest/api/3/search/jql");
});

test("previews Jira issues using GET only, with explicit pagination and sanitized links", async () => {
  let options;
  const result = await previewTasks(normalizeConnection(config()), "test-secret", async (_url, input) => {
    options = input;
    return new Response(JSON.stringify({ total: 100, issues: [{ key: "DEMO-1", fields: { summary: "Login bug", status: { name: "Open" }, assignee: null } }] }));
  });
  assert.equal(options.method, "GET");
  assert.equal(options.redirect, "manual");
  assert.equal(options.credentials, "omit");
  assert.equal(result.items[0].url, "https://jira.example.test/team/browse/DEMO-1");
  assert.equal(result.items[0].assignee, "");
  assert.equal(result.hasMore, true);
  assert.equal(result.total, 100);
});

test("JSON adapter supports configurable array and field paths without rendering unsafe links", async () => {
  const connection = normalizeConnection(config({ kind: "json", auth: "browser", endpoint: "/read/tasks", mappings: { records: "data.rows", id: "number", title: "text", url: "link" } }));
  const result = await previewTasks(connection, "", async (_url, options) => {
    assert.equal(options.credentials, "include");
    return new Response(JSON.stringify({ data: { rows: [{ number: "42", text: "New task", link: "javascript:alert(1)" }] } }));
  });
  assert.deepEqual(result.items[0], { id: "42", title: "New task", status: "", assignee: "", priority: "", url: "" });
  assert.equal(result.total, null);
});

test("redirects, HTML login pages, missing fields and excessive payloads report actionable errors", async () => {
  const connection = normalizeConnection(config());
  for (const [response, pattern] of [
    [new Response("", { status: 302 }), /重定向/],
    [new Response("", { status: 403 }), /读取权限/],
    [new Response("<html>Login</html>"), /登录页面/],
    [new Response('{"rows":[]}'), /任务数组/],
    [new Response('{"issues":[{"key":"A"}]}'), /标题/],
    [new Response("x".repeat(2 * 1024 * 1024 + 1)), /2MB/]
  ]) await assert.rejects(previewTasks(connection, "", async () => response), pattern);
});

test("strips Jira UI suffixes, preserves JSON deployment subpath, and falls back cleanly on 404", async () => {
  const jira = normalizeConnection({
    name: "内网 Jira",
    kind: "jira-server",
    baseUrl: "https://jira.company.local/jira/secure/Dashboard.jspa",
    allowHttp: false,
    auth: "bearer",
    endpoint: "/api/tasks",
    query: "",
    mappings: {}
  });
  assert.equal(jira.baseUrl, "https://jira.company.local/jira");
  assert.equal(
    new URL(buildRequest(jira, "tok").url).pathname,
    "/jira/rest/api/2/search"
  );

  const jiraCloud = normalizeConnection({
    name: "Cloud Jira",
    kind: "jira-cloud",
    baseUrl: "https://team.atlassian.net/jira/your-work",
    allowHttp: false,
    auth: "bearer",
    endpoint: "/api/tasks",
    query: "",
    mappings: {}
  });
  assert.equal(jiraCloud.baseUrl, "https://team.atlassian.net");

  const jsonSubpath = normalizeConnection({
    name: "项目系统",
    kind: "json",
    baseUrl: "https://oa.local/pm",
    allowHttp: false,
    auth: "none",
    endpoint: "/api/my-bugs",
    query: "",
    mappings: { records: "data.items", id: "id", title: "title" }
  });
  assert.equal(
    buildRequest(jsonSubpath, "").url,
    "https://oa.local/pm/api/my-bugs"
  );

  const visited = [];
  const preview = await previewTasks(jira, "tok", async (url) => {
    visited.push(new URL(url).pathname);
    if (visited.length === 1) return new Response("", { status: 404 });
    return new Response(JSON.stringify({ issues: [{ key: "BUG-7", fields: { summary: "修复登录 404" } }], total: 1 }), { status: 200 });
  });
  assert.deepEqual(visited, ["/jira/rest/api/2/search", "/jira/rest/api/latest/search"]);
  assert.equal(preview.items[0].id, "BUG-7");

  await assert.rejects(
    previewTasks(jsonSubpath, "", async () => new Response("", { status: 404 })),
    /404.*\/pm\/api\/my-bugs/
  );
});

test("supports Qianfan EWS user-info + responsible tasks and hints when Qianfan host uses Jira kind", async () => {
  const qianfan = normalizeConnection({
    name: "平台任务",
    kind: "qianfan",
    baseUrl: "https://work.yunmun.cn/login",
    allowHttp: false,
    auth: "browser",
    endpoint: "/api/tasks",
    query: "",
    mappings: {}
  });
  assert.equal(qianfan.baseUrl, "https://work.yunmun.cn");

  const calls = [];
  const result = await previewTasks(qianfan, "", async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    if (String(url).endsWith("/ews/auth/user-info")) {
      return new Response(JSON.stringify({ code: 200, data: { personId: 42, name: "翟冲" } }), { status: 200 });
    }
    if (String(url).endsWith("/ews/task/responsible/42")) {
      return new Response(JSON.stringify({
        code: 200,
        data: [
          { id: 101, code: "QF-101", title: "修复登录白屏", status: "进行中", priority: "高", responsibleName: "翟冲" },
          { id: 102, code: "QF-102", title: "历史已关闭任务", status: "已完成", priority: "中", responsibleName: "翟冲" }
        ]
      }), { status: 200 });
    }
    return new Response("", { status: 404 });
  }, { authorization: "Bearer test-token" });

  assert.equal(calls.length, 2);
  assert.equal(calls[0].auth, "Bearer test-token");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "QF-101");
  assert.equal(result.items[0].title, "修复登录白屏");

  const wrongKind = normalizeConnection({
    name: "平台任务",
    kind: "jira-server",
    baseUrl: "https://work.yunmun.cn",
    allowHttp: false,
    auth: "browser",
    endpoint: "/api/tasks",
    query: "",
    mappings: {}
  });
  await assert.rejects(
    previewTasks(wrongKind, "", async () => new Response("", { status: 404 })),
    /千帆平台地址/
  );
});
