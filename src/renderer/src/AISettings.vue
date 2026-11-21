<script setup lang="ts">
import { computed, onMounted, ref } from "vue"
import type { AIConfig, AIModel, AIRecord } from "../../shared/desk"

const draft = ref<(AIConfig & { apiKey: string; clearApiKey?: boolean }) | null>(null)
const baseline = ref("")
const dirty = computed(() => JSON.stringify(draft.value) !== baseline.value)
const models = ref<AIModel[]>([])
const records = ref<AIRecord[]>([])
const busy = ref(false)
const probeBusy = ref(false)
const message = ref("")
const failed = ref(false)
const stageFields = [
  { key: "defaultModel" as const, label: "默认模型" },
  { key: "analysisModel" as const, label: "需求分析模型（可跟随默认）" },
  { key: "codingModel" as const, label: "编码模型（可跟随默认）" },
  { key: "reviewModel" as const, label: "审核模型（可跟随默认）" }
]
type StageKey = (typeof stageFields)[number]["key"]

const openPickerKey = ref<StageKey | null>(null)
const pickerFiltering = ref(false)
const activeOptionIndex = ref(-1)
let closeTimer: ReturnType<typeof setTimeout> | null = null

function filteredModels(key: StageKey): AIModel[] {
  if (!pickerFiltering.value || !draft.value) {
    return models.value
  }
  const query = String(draft.value[key] || "").trim().toLowerCase()
  if (!query) {
    return models.value
  }
  const matched = models.value.filter(
    (model) => model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query)
  )
  return matched.length ? matched : models.value
}

function openPicker(key: StageKey): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer)
    closeTimer = null
  }
  openPickerKey.value = key
  pickerFiltering.value = false
  activeOptionIndex.value = -1
}

function togglePicker(key: StageKey): void {
  if (openPickerKey.value === key) {
    closePicker()
    return
  }
  openPicker(key)
}

function onModelInput(key: StageKey): void {
  openPickerKey.value = key
  pickerFiltering.value = true
  activeOptionIndex.value = -1
}

function closePicker(): void {
  openPickerKey.value = null
  pickerFiltering.value = false
  activeOptionIndex.value = -1
}

function closePickerLater(key: StageKey): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer)
  }
  closeTimer = setTimeout(() => {
    closeTimer = null
    if (openPickerKey.value === key) {
      closePicker()
    }
  }, 120)
}

function selectModel(key: StageKey, modelId: string): void {
  if (draft.value) {
    draft.value[key] = modelId
  }
  closePicker()
}

function moveOption(key: StageKey, delta: number): void {
  const list = filteredModels(key)
  if (!list.length) {
    return
  }
  if (openPickerKey.value !== key) {
    openPicker(key)
  }
  const next = activeOptionIndex.value + delta
  if (next < 0) {
    activeOptionIndex.value = list.length - 1
  } else if (next >= list.length) {
    activeOptionIndex.value = 0
  } else {
    activeOptionIndex.value = next
  }
}

function applyActiveOption(event: KeyboardEvent, key: StageKey): void {
  const list = filteredModels(key)
  if (openPickerKey.value === key && activeOptionIndex.value >= 0 && list[activeOptionIndex.value]) {
    event.preventDefault()
    selectModel(key, list[activeOptionIndex.value].id)
  }
}

function apply(config: AIConfig): void {
  draft.value = { ...config, apiKey: "" }
  baseline.value = JSON.stringify(draft.value)
}

async function perform(action: () => Promise<void>): Promise<void> {
  busy.value = true
  failed.value = false
  message.value = ""
  try { await action() } catch (error) {
    failed.value = true
    message.value = (error instanceof Error ? error.message : "操作失败").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
  } finally { busy.value = false }
}

onMounted(() => perform(async () => {
  apply(await window.desk.getAIConfig())
  if (window.desk.listCachedAIModels) {
    models.value = await window.desk.listCachedAIModels()
  }
  records.value = await window.desk.getAIHistory()
}))

async function save(): Promise<void> {
  await perform(async () => {
    if (!draft.value) return
    const previous = JSON.parse(baseline.value)
    // The cached model list was fetched under the old credentials: it
    // must be cleared when the auth mode changes too, not only when
    // the address or provider changes.
    const changed = previous.baseUrl !== draft.value.baseUrl || previous.provider !== draft.value.provider || previous.auth !== draft.value.auth
    apply(await window.desk.saveAIConfig(JSON.parse(JSON.stringify(draft.value))))
    if (changed) models.value = []
    message.value = "AI 设置已保存。只影响分身，不会修改 Magpie 或其他程序的全局配置。"
  })
}

function clearSavedKey(): void {
  if (!draft.value) return
  draft.value.clearApiKey = true
  draft.value.apiKey = ""
}

async function refreshModels(): Promise<void> {
  await perform(async () => {
    if (!draft.value) return
    const loaded = await window.desk.listAIModels({
      provider: draft.value.provider,
      protocol: draft.value.protocol,
      baseUrl: draft.value.baseUrl,
      allowHttp: draft.value.allowHttp,
      auth: draft.value.auth,
      apiKey: draft.value.apiKey,
      timeoutSeconds: draft.value.timeoutSeconds,
      metadataRetries: draft.value.metadataRetries
    })
    models.value = loaded
    let pickedNote = ""
    if (!draft.value.defaultModel && loaded.length > 0) {
      draft.value.defaultModel = loaded[0].id
      pickedNote = "已自动填入首个默认模型，如需调整请在下方选择。"
    }
    message.value = "网关连接成功，读取到 " + loaded.length + " 个模型／路由项。" + (pickedNote || "请在下方选择默认模型，勾选启用后点击「保存设置」。")
  })
}

async function testChat(): Promise<void> {
  probeBusy.value = true
  try {
    await perform(async () => {
      if (!window.desk.testAIChat) return
      const result = await window.desk.testAIChat("default")
      message.value = result.text + " 请求：" + result.requestedModel + "；响应模型：" + result.model
      records.value = await window.desk.getAIHistory()
    })
  } finally { probeBusy.value = false }
}

async function probe(): Promise<void> {
  probeBusy.value = true
  try {
    await perform(async () => {
      const result = await window.desk.probeAI()
      message.value = result.text + " 请求：" + result.requestedModel + "；响应模型：" + result.model
      records.value = await window.desk.getAIHistory()
    })
  } finally { probeBusy.value = false }
}

function cancel(): void { window.desk.cancelAI().catch(() => {}) }

async function chooseExecutor(): Promise<void> {
  await perform(async () => {
    const selected = await window.desk.chooseCodex()
    if (selected && draft.value) draft.value.executorPath = selected
  })
}

async function sandbox(): Promise<void> {
  probeBusy.value = true
  try {
    await perform(async () => {
      const result = await window.desk.runAISandbox()
      failed.value = !result.ok
      message.value = result.message + "\n请求模型：" + result.requestedModel + "\n示例目录：" + result.workspace
    })
  } finally { probeBusy.value = false }
}
</script>

<template>
  <section class="ai-settings" aria-label="AI 模型设置">
    <div class="section-intro">
      <h2>AI 模型</h2>
      <p class="hint">分身通过网关使用模型。系统账号、模型凭证和任务执行权限分别管理。</p>
    </div>
    <form v-if="draft" @submit.prevent="save">
      <fieldset :disabled="busy" class="settings-card">
        <legend>网关连接</legend>
        <div class="form-row two-col">
          <div class="field-block">
            <label for="ai-provider">提供方</label>
            <select id="ai-provider" v-model="draft.provider">
              <option value="magpie">Magpie</option>
              <option value="compatible">其他 OpenAI 兼容服务</option>
            </select>
          </div>
          <div class="field-block">
            <label for="ai-protocol">调用协议</label>
            <select id="ai-protocol" v-model="draft.protocol">
              <option value="chat">Chat Completions</option>
              <option value="responses">Responses</option>
            </select>
          </div>
        </div>
        <div class="field-block">
          <label for="ai-base-url">网关 Base URL</label>
          <input id="ai-base-url" v-model="draft.baseUrl" required type="url" placeholder="http://127.0.0.1:3425/v1" />
        </div>
        <label class="checkbox">
          <input v-model="draft.allowHttp" type="checkbox" />
          <span>允许远程 HTTP（凭证和内容可能明文传输）</span>
        </label>
        <div class="form-row two-col">
          <div class="field-block">
            <label for="ai-auth">认证方式</label>
            <select id="ai-auth" v-model="draft.auth">
              <option value="bearer">Bearer Key</option>
              <option value="none">不需要认证</option>
            </select>
          </div>
          <div v-if="draft.auth === 'bearer'" class="field-block">
            <label for="ai-api-key">网关 Key</label>
            <input
              id="ai-api-key"
              v-model="draft.apiKey"
              type="password"
              autocomplete="new-password"
              :placeholder="draft.keyConfigured ? '已保存，留空保留；修改地址需要重填' : '本机 Magpie 可留空；远程网关填写专属 Key'"
            />
            <button v-if="draft.keyConfigured && !draft.clearApiKey" type="button" @click="clearSavedKey">清除已保存的 Key</button>
            <p v-if="draft.clearApiKey" class="hint">保存后将清除已保存的 Key。</p>
          </div>
        </div>
        <p class="hint">本机 Magpie 留空时使用应用标识归属用量；远程网关需要其签发的 Key。不会读取供应商账号或复制其密钥。</p>
        <div class="actions">
          <button class="primary" type="submit">保存设置</button>
          <button type="button" @click="refreshModels">检测网关 / 刷新模型</button>
        </div>
        <p v-if="dirty" class="dirty-tip">当前有未保存修改；检测网关会直接使用当前表单配置，启用或对话测试前请先保存。</p>
      </fieldset>

      <fieldset :disabled="busy" class="settings-card">
        <legend>模型分工</legend>
        <p class="hint">从实际模型目录选择，也可以填写完整模型 ID。目录可见不代表已经通过工具调用验证。</p>
        <div class="form-row two-col">
          <div v-for="item in stageFields" :key="item.key" class="field-block">
            <label :for="'ai-stage-' + item.key">{{ item.label }}</label>
            <div class="model-picker">
              <input
                :id="'ai-stage-' + item.key"
                v-model="draft[item.key]"
                type="text"
                autocomplete="off"
                :class="{ 'has-toggle': models.length > 0 }"
                :placeholder="item.key === 'defaultModel' ? '选择或填写模型 ID' : '留空跟随默认模型'"
                :aria-expanded="openPickerKey === item.key && filteredModels(item.key).length > 0"
                @focus="openPicker(item.key)"
                @click="openPicker(item.key)"
                @input="onModelInput(item.key)"
                @blur="closePickerLater(item.key)"
                @keydown.down.prevent="moveOption(item.key, 1)"
                @keydown.up.prevent="moveOption(item.key, -1)"
                @keydown.enter="applyActiveOption($event, item.key)"
                @keydown.escape="closePicker()"
              />
              <button
                v-if="models.length > 0"
                class="picker-toggle"
                type="button"
                tabindex="-1"
                aria-label="展开模型列表"
                @mousedown.prevent="togglePicker(item.key)"
              >
                <svg class="picker-chevron" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
              <ul
                v-if="openPickerKey === item.key && filteredModels(item.key).length > 0"
                class="model-menu"
                role="listbox"
              >
                <li
                  v-for="(model, idx) in filteredModels(item.key)"
                  :key="model.id"
                  role="option"
                  :aria-selected="draft[item.key] === model.id"
                  class="model-option"
                  :class="{ active: idx === activeOptionIndex, selected: draft[item.key] === model.id }"
                  @mousedown.prevent="selectModel(item.key, model.id)"
                >
                  <span class="model-id">{{ model.id }}</span>
                  <span v-if="model.name && model.name !== model.id" class="model-name">{{ model.name }}</span>
                </li>
              </ul>
            </div>
          </div>
        </div>
        <label class="checkbox">
          <input v-model="draft.enabled" type="checkbox" />
          <span>启用分身 AI 问答与分析</span>
        </label>
        <div class="form-row three-col">
          <div class="field-block">
            <label for="ai-timeout">请求超时（秒）</label>
            <input id="ai-timeout" v-model.number="draft.timeoutSeconds" type="number" min="5" max="300" required />
          </div>
          <div class="field-block">
            <label for="ai-output-limit">单次输出 Token 上限</label>
            <input id="ai-output-limit" v-model.number="draft.outputLimit" type="number" min="128" max="16384" required />
          </div>
          <div class="field-block">
            <label for="ai-retries">模型目录读取重试</label>
            <input id="ai-retries" v-model.number="draft.metadataRetries" type="number" min="0" max="2" required />
          </div>
        </div>
        <p class="hint">模型生成不会自动重试，避免重复消耗。故障切换可由 Magpie 路由组管理。</p>
      </fieldset>

      <fieldset :disabled="busy" class="settings-card">
        <legend>代码执行器验证</legend>
        <div class="field-block">
          <label for="ai-executor">Codex 原生可执行文件</label>
          <input id="ai-executor" v-model="draft.executorPath" placeholder="选择 codex.exe，不填写 .cmd 脚本" />
        </div>
        <div class="actions">
          <button type="button" :disabled="busy || dirty || !draft?.enabled" @click="testChat">测试对话连通</button>
          <button type="button" @click="chooseExecutor">选择执行器文件</button>
          <button type="button" :disabled="busy || dirty || !draft?.enabled" @click="probe">验证编码模型工具调用</button>
          <button
            type="button"
            :disabled="busy || dirty || !draft?.enabled || draft?.provider !== 'magpie' || !draft.executorPath"
            :title="draft?.provider !== 'magpie' ? '隔离示例仅支持本机 Magpie' : ''"
            @click="sandbox"
          >验证 Codex 隔离示例</button>
        </div>
        <p class="hint">隔离示例仅支持本机 Magpie：创建临时示例，修复固定加法 Bug，再独立测试。保留 workspace-write 沙箱，不修改全局 AI 配置或真实仓库。</p>
        <p class="hint">工具验证会调用两轮模型、消耗相应额度；仅回传固定测试数据，不读取文件、不执行电脑命令。</p>
      </fieldset>
    </form>
    <div v-if="probeBusy" class="actions">
      <button type="button" @click="cancel">停止 AI 请求</button>
    </div>
    <p v-if="busy" class="result" role="status">正在连接或等待模型返回…</p>
    <p v-if="message" class="result" :class="{ failed }" role="status">{{ message }}</p>
    <details class="history settings-card">
      <summary>最近调用记录（{{ records.length }}）</summary>
      <p class="hint">仅记录模型、耗时、状态和 Token；不保存对话正文或密钥。响应未提供实际模型时显示 unknown。</p>
      <ul>
        <li v-for="record in records" :key="record.id">
          <strong>{{ record.requestedModel }} → {{ record.model }}</strong>
          <p>{{ record.status }} · {{ record.durationMs }} ms · 输入 {{ record.inputTokens ?? '未知' }} / 输出 {{ record.outputTokens ?? '未知' }}</p>
        </li>
      </ul>
    </details>
  </section>
</template>

<style scoped>
.ai-settings {
  flex: 1;
  min-height: 0;
  padding: 20px 24px 32px;
  overflow-y: auto;
  background: var(--page-bg);
  color: #222c38;
}
.section-intro {
  margin-bottom: 4px;
}
h2, h3, p {
  margin: 0;
}
h2 {
  font-size: 18px;
  font-weight: 600;
}
.field-block {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-top: 12px;
}
.field-block > label {
  color: #344150;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
}
input, select {
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  height: 38px;
  margin-top: 6px;
  padding: 0 11px;
  border: 1px solid #cbd5e1;
  border-radius: var(--radius-sm);
  background: #ffffff;
  color: #222c38;
  font: inherit;
  font-size: 13px;
  transition: border-color 150ms ease-out, box-shadow 150ms ease-out;
}
input:hover:not(:disabled),
select:hover:not(:disabled) {
  border-color: #94a3b8;
}
input:focus,
select:focus {
  border-color: #3555c5;
  box-shadow: var(--focus-ring);
  outline: none;
}
input:disabled,
select:disabled {
  background: #f3f5f8;
  color: #64748b;
}
input::placeholder {
  color: #8a96a6;
}
.model-picker {
  position: relative;
  margin-top: 6px;
}
.model-picker input {
  margin-top: 0;
}
.model-picker input.has-toggle {
  padding-right: 34px;
}
.picker-toggle {
  position: absolute;
  top: 1px;
  right: 1px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 36px;
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: 0 6px 6px 0;
  background: transparent;
  color: #586575;
}
.picker-toggle:hover {
  background: #f2f5f9;
  color: #222c38;
}
.picker-chevron {
  width: 14px;
  height: 14px;
}
.model-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  max-height: 220px;
  margin: 0;
  padding: 4px;
  overflow-y: auto;
  list-style: none;
  border: 1px solid #d3dcea;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 8px 24px rgba(34, 44, 56, 0.12);
}
.model-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
  transition: background-color 150ms ease-out;
}
.model-option:hover,
.model-option.active {
  background: #f2f5f9;
}
.model-option.selected {
  background: #eaf0fc;
  color: #284689;
  font-weight: 500;
}
.model-id {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-name {
  flex-shrink: 0;
  margin-left: 10px;
  color: #586575;
  font-size: 12px;
}
.form-row {
  display: flex;
  flex-wrap: wrap;
  margin-right: -12px;
}
.form-row > .field-block {
  margin-right: 12px;
}
.form-row.two-col > .field-block {
  flex: 1 1 calc(50% - 12px);
  min-width: 220px;
  max-width: calc(50% - 12px);
}
.form-row.three-col > .field-block {
  flex: 1 1 160px;
}
@media (max-width: 560px) {
  .form-row.two-col > .field-block {
    flex: 1 1 100%;
    max-width: 100%;
  }
}
.history {
  margin-top: 14px;
}
summary {
  color: #284689;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.history ul {
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}
.history li {
  padding: 10px 0;
  border-bottom: 1px solid #e3e7ec;
  overflow-wrap: anywhere;
}
.history li:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}
.history li p {
  margin-top: 4px;
  color: #586575;
  font-size: 12px;
}
@media (prefers-reduced-motion: reduce) {
  input,
  select,
  .model-option {
    transition: none;
  }
}
</style>
