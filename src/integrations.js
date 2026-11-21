const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function field(value, maximum = 500) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function stripJiraUiPath(pathname) {
  let cleaned = pathname || "/";
  cleaned = cleaned.replace(/\/jira\/(?:your-work|dashboards|filters|people|projects\/.*|software\/.*)$/i, "/");
  cleaned = cleaned.replace(/\/(?:login\.jsp|index\.html|secure(?:\/.*)?|browse\/.*|projects\/.*|issues(?:\/.*)?)$/i, "/");
  cleaned = cleaned.replace(/\/+$/, "") || "/";
  return cleaned;
}

function joinEndpoint(baseUrl, endpoint) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/$/, "");
  if (!basePath || endpoint === basePath || endpoint.startsWith(basePath + "/") || endpoint.startsWith(basePath + "?")) {
    return new URL(endpoint, base.origin + "/");
  }
  return new URL(basePath + endpoint, base.origin + "/");
}

function normalizeConnection(input) {
  if (!input || typeof input !== "object") throw new Error("接入配置无效");
  const name = field(input.name, 60);
  if (!name) throw new Error("请填写系统名称");
  if (!["jira-cloud", "jira-server", "qianfan", "json"].includes(input.kind)) throw new Error("请选择系统类型");
  let base;
  try { base = new URL(field(input.baseUrl, 2000)); } catch { throw new Error("请填写有效的系统地址"); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error("系统地址只允许 HTTP/HTTPS，不能包含账号、查询参数或片段");
  }
  if (input.kind === "jira-cloud" || input.kind === "jira-server") base.pathname = stripJiraUiPath(base.pathname);
  if (input.kind === "qianfan") base.pathname = "/";
  if (base.protocol === "http:" && input.allowHttp !== true) throw new Error("HTTP 地址需要明确允许内网明文连接");
  if (!["none", "browser", "bearer", "basic", "header"].includes(input.auth)) throw new Error("认证方式无效");
  const headerName = field(input.headerName, 80) || "X-API-Key";
  if (!/^[a-zA-Z][a-zA-Z0-9-]*$/.test(headerName) || /^(host|connection|content-length|accept|cookie|proxy-authorization)$/i.test(headerName)) {
    throw new Error("自定义认证头名称无效");
  }
  const endpoint = field(input.endpoint, 2000) || "/api/tasks";
  if (!endpoint.startsWith("/") || endpoint.startsWith("//") || endpoint.includes("\\")) throw new Error("任务接口应为本站相对路径，例如 /api/tasks");
  const target = joinEndpoint(base.href, endpoint);
  if (target.origin !== base.origin || target.hash || /(?:token|password|secret|api[_-]?key|authorization)/i.test(Array.from(target.searchParams.keys()).join(" "))) {
    throw new Error("接口地址不能跨站或在查询参数中包含凭证");
  }
  const mappings = {};
  for (const key of ["records", "id", "title", "status", "assignee", "priority", "url"]) {
    const value = field(input.mappings && input.mappings[key], 150);
    if (value && !/^[a-zA-Z0-9_.]+$/.test(value)) throw new Error("字段映射只支持点分路径，例如 data.items");
    mappings[key] = value;
  }
  return {
    id: field(input.id, 60), name, kind: input.kind, baseUrl: base.href.replace(/\/$/, ""),
    allowHttp: input.allowHttp === true, auth: input.auth,
    username: field(input.username, 200), headerName, endpoint,
    query: field(input.query, 4000), mappings
  };
}

function publicConnection(connection) {
  const { encryptedSecret, ...config } = connection;
  return { ...config, secretConfigured: Boolean(encryptedSecret) };
}

function createIntegrationStore(filePath, crypto) {
  let queue = Promise.resolve();
  function read() {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (data.version !== 1 || !Array.isArray(data.connections)) throw new Error("invalid");
      return data.connections;
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw new Error("接入配置文件无法读取，请保留文件并检查，未覆盖原配置");
    }
  }
  function write(connections) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = filePath + ".tmp";
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, connections }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, filePath);
  }
  function mutate(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  return {
    list: () => read().map(publicConnection),
    save(input) {
      return mutate(async () => {
        const config = normalizeConnection(input);
        const connections = read();
        const previous = connections.find((connection) => connection.id === config.id);
        if (config.id && !previous) throw new Error("此接入已删除，请重新创建");
        if (!previous && connections.length >= 30) throw new Error("最多保存 30 个接入");
        config.id = previous ? previous.id : randomUUID();
        let encryptedSecret = previous ? previous.encryptedSecret : "";
        const bindingChanged = previous && ["baseUrl", "auth", "username", "headerName"].some((key) => config[key] !== previous[key]);
        const needsSecret = !["none", "browser"].includes(config.auth);
        if (bindingChanged || input.clearSecret === true || !needsSecret) encryptedSecret = "";
        const secret = typeof input.secret === "string" ? input.secret : "";
        if (secret.length > 8000) throw new Error("凭证长度超过限制");
        if (/[\r\n]/.test(secret)) throw new Error("凭证不能包含换行");
        if (secret && needsSecret) encryptedSecret = (await crypto.encrypt(secret)).toString("base64");
        if (needsSecret && !encryptedSecret) throw new Error("请填写认证凭证；修改地址或认证方式后需要重新填写");
        if (config.auth === "basic" && (!config.username || config.username.includes(":"))) throw new Error("Basic 认证需要有效的用户名或邮箱");
        const saved = { ...config, encryptedSecret };
        write([...connections.filter((connection) => connection.id !== saved.id), saved]);
        return publicConnection(saved);
      });
    },
    remove(id) {
      return mutate(() => {
        write(read().filter((connection) => connection.id !== id));
        return true;
      });
    },
    async resolve(id) {
      const connection = read().find((item) => item.id === id);
      if (!connection) throw new Error("接入不存在");
      const secret = connection.encryptedSecret ? await crypto.decrypt(Buffer.from(connection.encryptedSecret, "base64")) : "";
      return { config: normalizeConnection(connection), secret };
    }
  };
}

function atPath(value, key) {
  return key ? key.split(".").reduce((current, segment) => current && Object.prototype.hasOwnProperty.call(current, segment) ? current[segment] : undefined, value) : value;
}

function jiraUrl(baseUrl, apiPath, query) {
  const cleanBase = String(baseUrl || "").replace(/\/$/, "");
  const url = new URL(cleanBase + apiPath);
  url.searchParams.set("jql", query || "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC");
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("fields", "summary,status,assignee,priority");
  return url;
}

function buildRequest(config, secret, extraAuth = {}) {
  let url;
  if (config.kind === "json") {
    url = joinEndpoint(config.baseUrl, config.endpoint);
  } else if (config.kind === "qianfan") {
    url = new URL(String(config.baseUrl || "").replace(/\/$/, "") + "/ews/auth/user-info");
  } else {
    url = jiraUrl(config.baseUrl, config.kind === "jira-cloud" ? "/rest/api/3/search/jql" : "/rest/api/2/search", config.query);
  }
  const headers = { Accept: "application/json" };
  if (config.auth === "bearer") headers.Authorization = "Bearer " + secret;
  if (config.auth === "basic") headers.Authorization = "Basic " + Buffer.from(config.username + ":" + secret).toString("base64");
  if (config.auth === "header") headers[config.headerName] = secret;
  if (config.auth === "browser" && extraAuth && extraAuth.authorization) headers.Authorization = extraAuth.authorization;
  return { url: url.href, headers };
}

async function readBoundedJson(response) {
  if (response.status >= 300 && response.status < 400) throw new Error("接口发生重定向，请检查地址或登录方式");
  if (response.status === 401 || response.status === 403) throw new Error("认证失败或登录已失效，请重新登录并检查权限");
  if (!response.ok) return { ok: false, status: response.status, payload: null };
  const reader = response.body && response.body.getReader();
  if (!reader) throw new Error("接口返回空响应");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("响应超过 2MB，请缩小查询范围");
    }
    chunks.push(Buffer.from(value));
  }
  try {
    return { ok: true, status: response.status, payload: JSON.parse(Buffer.concat(chunks).toString("utf8")) };
  } catch {
    throw new Error("接口未返回 JSON，可能是登录页面或地址配置不正确");
  }
}

async function previewQianfanTasks(config, headers, fetcher, signal) {
  const base = String(config.baseUrl || "").replace(/\/$/, "");
  const credentials = config.auth === "browser" ? "include" : "omit";
  const meRes = await fetcher(base + "/ews/auth/user-info", { method: "GET", headers, redirect: "manual", credentials, signal });
  const meBody = await readBoundedJson(meRes);
  if (!meBody.ok) throw new Error("无法获取千帆登录身份（HTTP " + meBody.status + "），请先点击「打开登录窗口」完成登录");
  const user = (meBody.payload && meBody.payload.data) || meBody.payload || {};
  const personId = user.personId ?? user.id ?? user.userId;
  if (!personId && personId !== 0) throw new Error("未登录千帆账号，请点击「打开登录窗口」完成登录");

  let taskList = null;
  const getRes = await fetcher(base + "/ews/task/responsible/" + encodeURIComponent(String(personId)), { method: "GET", headers, redirect: "manual", credentials, signal });
  if (getRes.ok) {
    const body = await readBoundedJson(getRes);
    const list = body.payload && (Array.isArray(body.payload.data) ? body.payload.data : (body.payload.data && Array.isArray(body.payload.data.records) ? body.payload.data.records : null));
    if (Array.isArray(list)) taskList = list;
  }
  if (!taskList) {
    const postRes = await fetcher(base + "/ews/task/advanced-search", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ responsibleId: personId, uncompletedOnly: true, pageNum: 1, pageSize: 50 }),
      redirect: "manual",
      credentials,
      signal
    });
    const postBody = await readBoundedJson(postRes);
    if (!postBody.ok) throw new Error("千帆任务接口请求失败，HTTP " + postBody.status);
    const d = postBody.payload && postBody.payload.data;
    taskList = Array.isArray(d) ? d : (d && (Array.isArray(d.records) ? d.records : Array.isArray(d.list) ? d.list : null));
  }
  if (!Array.isArray(taskList)) throw new Error("找不到千帆任务列表，请确认接口权限");
  const activeOnly = taskList.filter((item) => {
    const status = String((item && item.status) || "");
    return !/^(?:已完成|已取消|已关闭|DONE|CLOSED)$/i.test(status.trim());
  });
  const items = activeOnly.slice(0, 50).map((item, idx) => {
    const rawId = item.code || item.taskCode || item.id || String(idx + 1);
    const title = field(String(item.title || item.taskName || item.name || ""), 400);
    if (!title) throw new Error("部分千帆任务缺少标题");
    return {
      id: field(String(rawId), 120),
      title,
      status: field(String(item.status || ""), 80),
      assignee: field(String(item.responsibleName || user.name || ""), 80),
      priority: field(String(item.priority || item.taskType || ""), 80),
      // No verified per-task deep link for Qianfan: leave it empty
      // rather than pointing every task at the generic task list.
      url: ""
    };
  });
  return { items, total: activeOnly.length, hasMore: activeOnly.length > 50 };
}

function candidateUrls(config, primaryUrl) {
  if (config.kind === "jira-cloud") {
    return [primaryUrl, jiraUrl(config.baseUrl, "/rest/api/3/search", config.query).href];
  }
  if (config.kind === "jira-server") {
    return [primaryUrl, jiraUrl(config.baseUrl, "/rest/api/latest/search", config.query).href];
  }
  return [primaryUrl];
}

async function previewTasks(config, secret, fetcher = fetch, extraAuth = {}) {
  const request = buildRequest(config, secret, extraAuth);
  const candidates = candidateUrls(config, request.url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    if (config.kind === "qianfan") {
      return await previewQianfanTasks(config, request.headers, fetcher, controller.signal);
    }
    let response = null;
    let activeUrl = candidates[0];
    for (let index = 0; index < candidates.length; index += 1) {
      activeUrl = candidates[index];
      response = await fetcher(activeUrl, { method: "GET", headers: request.headers, redirect: "manual", credentials: config.auth === "browser" ? "include" : "omit", signal: controller.signal });
      if (response.status !== 404 || index === candidates.length - 1) break;
    }
    const requestPath = (() => { try { return new URL(activeUrl).pathname; } catch { return candidates[0]; } })();
    if (response.status >= 300 && response.status < 400) throw new Error("接口发生重定向，请检查地址或登录方式");
    if (response.status === 401 || response.status === 403) throw new Error("认证失败或没有读取权限，请检查账号与凭证");
    if (response.status === 404) {
      const isQianfanHost = /yunmun\.cn/i.test(String(config.baseUrl || ""));
      if (isQianfanHost) {
        throw new Error("检测到千帆平台地址，请将「系统类型」切换为「千帆 · 研发管理平台」并保存后重试");
      }
      throw new Error(config.kind === "json"
        ? `接口返回 404（请求路径：${requestPath}），请确认 GET 接口路径和系统子路径是否正确`
        : `接口返回 404（请求路径：${requestPath}），请确认系统地址与部署子路径（如 /jira）是否正确，或改用「内部系统 · JSON 接口」手动指定接口路径`);
    }
    if (response.status === 405) throw new Error(`接口不支持 GET 请求（HTTP 405，路径：${requestPath}）`);
    if (!response.ok) throw new Error(`接口请求失败，HTTP ${response.status}（${requestPath}）`);
    const reader = response.body && response.body.getReader();
    if (!reader) throw new Error("接口返回空响应");
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2 * 1024 * 1024) {
        await reader.cancel();
        throw new Error("响应超过 2MB，请缩小查询范围");
      }
      chunks.push(Buffer.from(value));
    }
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("接口未返回 JSON，可能是登录页面或地址配置不正确"); }
    const records = config.kind === "json" ? atPath(payload, config.mappings.records) : payload.issues;
    if (!Array.isArray(records)) throw new Error("找不到任务数组，请检查接口及列表字段映射");
    const items = records.slice(0, 50).map((record, index) => {
      const jira = config.kind === "jira-cloud" || config.kind === "jira-server";
      const text = (key, jiraPath, fallback = "") => {
        const mapped = jira ? jiraPath : config.mappings[key];
        return mapped ? field(String(atPath(record, mapped) ?? fallback), 400) : fallback;
      };
      const id = text("id", "key", String(index + 1));
      const title = text("title", "fields.summary");
      if (!title) throw new Error("部分任务没有标题，请检查标题字段映射");
      let url = "";
      try {
        const link = jira ? config.baseUrl + "/browse/" + encodeURIComponent(id) : text("url", "");
        const target = new URL(link || "about:blank", config.baseUrl);
        if (target.origin === new URL(config.baseUrl).origin && ["http:", "https:"].includes(target.protocol) && !target.username && !target.password) url = target.href;
      } catch {}
      return { id, title, status: text("status", "fields.status.name"), assignee: text("assignee", "fields.assignee.displayName"), priority: text("priority", "fields.priority.name"), url };
    });
    const total = Number.isSafeInteger(payload.total) && payload.total >= items.length ? payload.total : null;
    return { items, total, hasMore: records.length > 50 || Boolean(payload.nextPageToken) || payload.isLast === false || (total !== null && total > items.length) };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("连接超时，请检查网络或 VPN 后重试");
    if (error instanceof TypeError) throw new Error("无法连接，请检查地址、网络、VPN 或证书");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { normalizeConnection, createIntegrationStore, buildRequest, previewTasks };
