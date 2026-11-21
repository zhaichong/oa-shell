<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import type { ConnectionConfig, ConnectionDraft, TaskPreview } from "../../shared/desk"

const connections = ref<ConnectionConfig[]>([])
function emptyDraft(): ConnectionDraft {
  return { id: "", name: "", kind: "jira-server", baseUrl: "", allowHttp: false, auth: "browser", username: "", headerName: "X-API-Key", secret: "", endpoint: "/api/tasks", query: "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC", mappings: { records: "data.items", id: "id", title: "title", status: "status", assignee: "assignee", priority: "priority", url: "url" } }
}
const draft = ref<ConnectionDraft>(emptyDraft())
const baseline = ref(JSON.stringify(draft.value))
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const busy = ref(false)
const message = ref("")
const failed = ref(false)
const preview = ref<TaskPreview | null>(null)
const needsSecret = computed(() => !["none", "browser"].includes(draft.value.auth))
const mappingLabels: Record<string, string> = { records: "任务数组路径（留空表示根数组）", id: "任务编号", title: "标题", status: "状态", assignee: "负责人", priority: "优先级", url: "原始链接" }

function select(connection?: ConnectionConfig): void {
  draft.value = connection ? { ...connection, mappings: { ...connection.mappings }, secret: "" } : emptyDraft()
  baseline.value = JSON.stringify(draft.value)
  message.value = ""
  preview.value = null
}

function choose(connection?: ConnectionConfig): void {
  if (dirty.value && !window.confirm("放弃尚未保存的配置修改？")) return
  select(connection)
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : "操作失败，请重试").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
}

async function perform(action: () => Promise<void>): Promise<void> {
  busy.value = true
  message.value = ""
  failed.value = false
  try { await action() } catch (error) { failed.value = true; message.value = errorText(error) } finally { busy.value = false }
}

onMounted(() => perform(async () => { connections.value = await window.desk.listConnections() }))

async function save(): Promise<void> {
  await perform(async () => {
    const saved = await window.desk.saveConnection(JSON.parse(JSON.stringify(draft.value)))
    connections.value = await window.desk.listConnections()
    select(saved)
    message.value = "配置已保存。接下来可以登录、测试连接或预览任务。"
  })
}

async function inspect(onlyTest: boolean): Promise<void> {
  await perform(async () => {
    preview.value = null
    const result = await window.desk.previewConnection(draft.value.id)
    if (!onlyTest) preview.value = result
    message.value = onlyTest ? "连接成功，任务列表结构校验通过。本页返回 " + result.items.length + " 条。" : "已读取本页 " + result.items.length + " 条。" + (result.hasMore ? "还有更多任务，当前为前 50 条预览，并非全量统计。" : "")
  })
}

async function login(): Promise<void> {
  await perform(async () => {
    await window.desk.loginConnection(draft.value.id)
    message.value = "已打开独立登录窗口，请在窗口内完成登录，再测试连接。此方式仅适用于 Cookie 会话认证。"
  })
}

async function remove(): Promise<void> {
  if (!window.confirm("删除「" + draft.value.name + "」的接入配置？不会删除源系统任务。")) return
  await perform(async () => {
    await window.desk.removeConnection(draft.value.id)
    connections.value = await window.desk.listConnections()
    select()
    message.value = "接入配置已删除。"
  })
}
</script>

<template>
  <section class="integrations" aria-label="系统接入设置">
    <div class="intro">
      <h2>系统接入</h2>
      <p>先连接任务来源，再让分身查看待办。当前只读取，不领取或修改任务。</p>
    </div>
    <div class="connection-tabs" aria-label="已保存的接入">
      <button v-for="connection in connections" :key="connection.id" type="button" :class="{ selected: draft.id === connection.id }" :disabled="busy" @click="choose(connection)">{{ connection.name }}</button>
      <button type="button" :disabled="busy" @click="choose()">＋ 新增接入</button>
    </div>
    <form @submit.prevent="save" class="settings-card">
      <fieldset :disabled="busy">
        <legend>{{ draft.id ? '编辑接入' : '新增接入' }}</legend>
        <div class="form-row">
          <label>系统名称<input v-model="draft.name" required maxlength="60" placeholder="例如：研发 Jira" /></label>
          <label>系统类型<select v-model="draft.kind"><option value="jira-server">Jira 自建版 / Data Center</option><option value="jira-cloud">Jira Cloud</option><option value="qianfan">千帆 · 研发管理平台</option><option value="json">内部系统 · JSON 接口</option></select></label>
        </div>
        <label>系统地址<input v-model="draft.baseUrl" type="url" required placeholder="https://work.yunmun.cn 或 https://jira.company.local" /></label>
        <p class="hint">{{ draft.kind === 'json' ? 'JSON 接口会保留系统地址中的部署子路径，并与下方相对路径拼接。' : draft.kind === 'qianfan' ? '填写千帆地址后，建议认证方式选「浏览器登录」，点击下方「打开登录窗口」完成同舟统一认证即可读取你名下的任务。' : 'Jira 会自动基于系统地址请求 /rest/api/*/search 接口；无需粘贴 /secure/Dashboard.jspa 等页面路径。' }}</p>
        <label class="checkbox"><input v-model="draft.allowHttp" type="checkbox" />允许内网 HTTP 连接（账号和数据可能以明文传输）</label>
        <div class="form-row">
          <label>认证方式<select v-model="draft.auth"><option value="browser">浏览器登录（Cookie 会话）</option><option value="bearer">Bearer Token</option><option value="basic">Basic 用户名与凭证</option><option value="header">自定义认证头</option><option value="none">不需要认证</option></select></label>
          <label v-if="draft.auth === 'basic'">用户名 / 邮箱<input v-model="draft.username" autocomplete="off" /></label>
          <label v-if="draft.auth === 'header'">认证头名称<input v-model="draft.headerName" placeholder="X-API-Key" /></label>
        </div>
        <label v-if="needsSecret">认证凭证<input v-model="draft.secret" type="password" autocomplete="new-password" :placeholder="draft.secretConfigured ? '已保存，留空保留；修改地址或认证方式需重填' : '仅在此输入，使用系统安全存储加密保存'" /></label>
        <p v-if="draft.auth === 'browser'" class="hint">浏览器登录只适用于 Cookie 认证。使用请求头 Token 的系统请选择 Bearer Token 或自定义认证头。</p>
        <label v-if="draft.kind === 'jira-server' || draft.kind === 'jira-cloud'">任务筛选（JQL）<textarea v-model="draft.query" rows="3" placeholder="例如：project = DEMO AND issuetype = Bug AND resolution = Unresolved" /></label>
        <p v-else-if="draft.kind === 'qianfan'" class="hint">千帆默认读取你当前登录账号名下的未完成任务。</p>
        <template v-else>
          <label>读取任务的 GET 接口路径<input v-model="draft.endpoint" required placeholder="/api/tasks?status=open" /></label>
          <p class="hint">地址与字段结构按内部系统接口文档填写。当前支持 GET JSON 接口，不会凭网站首页地址猜测任务接口。</p>
          <details>
            <summary>字段映射</summary>
            <div class="form-row mappings">
              <label v-for="(label, key) in mappingLabels" :key="key">{{ label }}<input v-model="draft.mappings[key]" :placeholder="key === 'records' ? '例如 data.items' : '例如 fields.title'" /></label>
            </div>
          </details>
        </template>
        <div class="actions">
          <button class="primary" type="submit" :disabled="!draft.name || !draft.baseUrl">{{ busy ? '处理中…' : '保存配置' }}</button>
          <button v-if="draft.id" class="danger" type="button" @click="remove">删除接入</button>
        </div>
      </fieldset>
    </form>
    <div v-if="draft.id" class="actions">
      <button v-if="draft.auth === 'browser'" type="button" :disabled="busy || dirty" @click="login">打开登录窗口</button>
      <button type="button" :disabled="busy || dirty" @click="inspect(true)">测试连接</button>
      <button type="button" :disabled="busy || dirty" @click="inspect(false)">预览任务</button>
    </div>
    <p v-if="dirty" class="dirty-tip">配置有修改，请先保存后再测试。</p>
    <p v-if="busy" class="hint" role="status">正在处理，请稍候…</p>
    <p v-if="message" class="result" :class="{ failed }" role="status">{{ message }}</p>
    <div v-if="preview" class="preview settings-card">
      <h3>任务预览 <span v-if="preview.total !== null">源系统共 {{ preview.total }} 条</span></h3>
      <p v-if="!preview.items.length" class="hint">当前查询没有任务。可以调整筛选条件后重试。</p>
      <ol>
        <li v-for="item in preview.items" :key="item.id">
          <strong>{{ item.id }} · {{ item.title }}</strong>
          <p>{{ [item.status, item.assignee, item.priority].filter(Boolean).join(' · ') || '无附加信息' }}</p>
        </li>
      </ol>
    </div>
  </section>
</template>

<style scoped>
.integrations {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 20px 24px 32px;
  background: var(--page-bg);
  color: #222c38;
}
h2, h3, p {
  margin: 0;
}
h2 {
  font-size: 18px;
  font-weight: 600;
}
.intro p {
  margin-top: 8px;
  color: #586575;
  font-size: 12px;
  line-height: 1.65;
}
.connection-tabs {
  display: flex;
  flex-wrap: wrap;
  margin-top: 16px;
  border-bottom: 1px solid #e3e7ec;
}
.connection-tabs button {
  margin-right: 20px;
  padding: 10px 4px;
  border: 0;
  border-bottom: 2px solid transparent;
  background: transparent;
  color: #586575;
  font-size: 13px;
  font-weight: 500;
}
.connection-tabs button:hover:not(.selected) {
  color: #222c38;
}
.connection-tabs button.selected {
  border-bottom-color: #3555c5;
  color: #3555c5;
  font-weight: 600;
}
fieldset {
  margin: 0;
  padding: 0;
  border: 0;
}
label:not(.checkbox) {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-top: 12px;
  color: #344150;
  font-size: 12px;
  font-weight: 500;
}
input, select, textarea {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  margin-top: 6px;
  padding: 8px 11px;
  border: 1px solid #cbd5e1;
  border-radius: var(--radius-sm);
  background: #ffffff;
  color: #222c38;
  font: inherit;
  font-size: 13px;
  font-weight: 400;
  transition: border-color 150ms ease-out, box-shadow 150ms ease-out;
}
input, select {
  height: 38px;
  padding-top: 0;
  padding-bottom: 0;
}
input:hover:not(:disabled),
select:hover:not(:disabled),
textarea:hover:not(:disabled) {
  border-color: #94a3b8;
}
input:focus,
select:focus,
textarea:focus {
  border-color: #3555c5;
  box-shadow: var(--focus-ring);
  outline: none;
}
input:disabled,
select:disabled,
textarea:disabled {
  background: #f3f5f8;
  color: #64748b;
}
input::placeholder, textarea::placeholder {
  color: #8a96a6;
}
.form-row {
  display: flex;
  flex-wrap: wrap;
  margin-right: -12px;
}
.form-row > label {
  flex: 1 1 calc(50% - 12px);
  min-width: 220px;
  max-width: calc(50% - 12px);
  margin-right: 12px;
}
@media (max-width: 560px) {
  .form-row > label {
    flex: 1 1 100%;
    max-width: 100%;
  }
}
details {
  margin-top: 16px;
}
summary {
  color: #284689;
  font-weight: 600;
  cursor: pointer;
}
.preview {
  margin-top: 16px;
}
h3 {
  font-size: 14px;
  font-weight: 600;
}
h3 span {
  margin-left: 12px;
  color: #586575;
  font-size: 12px;
  font-weight: 400;
}
ol {
  margin: 12px 0 0;
  padding-left: 22px;
}
li {
  padding: 10px 0;
  border-bottom: 1px solid #e3e7ec;
  overflow-wrap: anywhere;
}
li:last-child {
  border-bottom: 0;
}
li p {
  margin-top: 4px;
  color: #586575;
  font-size: 12px;
}
@media (prefers-reduced-motion: reduce) {
  button,
  input,
  select,
  textarea {
    transition: none;
  }
}
</style>
