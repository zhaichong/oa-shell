<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue"
import type { AIModel, AIReply, JiraCodeDiscovery } from "../../shared/desk"

const props = defineProps<{ connectionId: string; bugKey: string }>()
defineEmits<{ close: [] }>()

const models = ref<AIModel[]>([])
const gateway = ref("")
const selected = ref("")
const repository = ref("")
const branch = ref("HEAD")
const files = ref("")
const busy = ref(false)
const finding = ref(false)
const advanced = ref(false)
const message = ref("")
const answer = ref<AIReply | null>(null)
const discovery = ref<JiraCodeDiscovery | null>(null)
const checkedPaths = ref<string[]>([])
const manualFiles = computed(() => [...new Set(files.value.split(/\r?\n/).map(file => file.trim().replace(/\\/g, "/")).filter(Boolean))])
const selectedFiles = computed(() => [...new Set([...checkedPaths.value, ...manualFiles.value])])
const extraFiles = computed(() => manualFiles.value.filter(file => !checkedPaths.value.includes(file)))
const selectedModelName = computed(() => models.value.find(model => model.id === selected.value)?.name || selected.value)
const manualHandoff = computed(() => selected.value === "codex-handoff")
const canAnalyze = computed(() => !!repository.value && !!branch.value && selectedFiles.value.length >= 1 && selectedFiles.value.length <= 6)

watch([repository, branch], () => {
  discovery.value = null
  checkedPaths.value = []
  answer.value = null
  message.value = ""
})

function errorText(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
    : "操作失败，请重试。"
}

onMounted(async () => {
  busy.value = true
  try {
    const options = await window.desk.getJiraAIOptions()
    models.value = options.models
    gateway.value = options.gateway
    selected.value = models.value[0]?.id || "codex-handoff"
  } catch (error) {
    message.value = errorText(error)
  } finally {
    busy.value = false
  }
})

async function findFiles(): Promise<void> {
  if (busy.value || !repository.value || !branch.value) return
  busy.value = true
  finding.value = true
  message.value = ""
  answer.value = null
  try {
    const result = await window.desk.findJiraCode({
      id: props.connectionId,
      key: props.bugKey,
      repository: repository.value,
      branch: branch.value
    })
    discovery.value = result
    checkedPaths.value = result.candidates.filter(item => item.selected).map(item => item.path)
    if (!result.candidates.length) {
      advanced.value = true
      message.value = "没找到相关文件，试试手动补充。"
    } else if (!checkedPaths.value.length) {
      message.value = "找到了可能相关的文件，请勾选后分析。"
    }
  } catch (error) {
    message.value = errorText(error)
  } finally {
    finding.value = false
    busy.value = false
  }
}

async function run(): Promise<void> {
  if (busy.value || !selected.value) return
  if (selected.value !== "codex-handoff" && (selectedFiles.value.length < 1 || selectedFiles.value.length > 6)) {
    message.value = "请选择 1–6 个文件再分析。"
    return
  }
  busy.value = true
  message.value = ""
  answer.value = null
  try {
    const issue = { id: props.connectionId, key: props.bugKey }
    if (selected.value === "codex-handoff") {
      await window.desk.copyJiraHandoff({ ...issue, repository: repository.value, branch: branch.value })
      message.value = "已复制交接内容。请在目标仓库的 Codex 对话中粘贴。"
    } else {
      answer.value = await window.desk.analyzeJiraBug({
        ...issue,
        model: selected.value,
        gateway: gateway.value,
        repository: repository.value,
        branch: branch.value,
        commit: discovery.value?.commit,
        files: selectedFiles.value
      })
    }
  } catch (error) {
    message.value = errorText(error)
  } finally {
    busy.value = false
  }
}

async function chooseRepository(): Promise<void> {
  if (busy.value) return
  let chosen: string | null = null
  busy.value = true
  try {
    chosen = await window.desk.chooseJiraRepository()
    if (chosen && chosen !== repository.value) {
      repository.value = chosen
      branch.value = "HEAD"
      files.value = ""
      advanced.value = false
    }
  } catch (error) {
    message.value = errorText(error)
  } finally {
    busy.value = false
  }
  if (chosen && !manualHandoff.value) await findFiles()
}
</script>

<template>
  <form class="handoff" :aria-label="'交给 AI：' + bugKey" @submit.prevent="run">
    <label>
      <span>执行者</span>
      <select v-model="selected" :disabled="busy">
        <option v-for="model in models" :key="model.id" :value="model.id">{{ model.name }} · 分析</option>
        <option value="codex-handoff">Codex · 手动交接</option>
      </select>
    </label>
    <template v-if="manualHandoff">
      <label class="repository-field">
        <span>目标仓库</span>
        <input v-model.trim="repository" maxlength="500" placeholder="本地 Git 仓库路径" required :disabled="busy">
        <button type="button" :disabled="busy" @click="chooseRepository">选择</button>
      </label>
      <label><span>基准分支</span><input v-model.trim="branch" maxlength="200" placeholder="例如 main 或 HEAD" required :disabled="busy"></label>
    </template>
    <template v-if="selected && !manualHandoff">
      <div class="repository-summary">
        <button type="button" :disabled="busy" @click="chooseRepository">{{ repository ? "更换仓库" : "选择本地仓库" }}</button>
        <code v-if="repository">{{ repository }}</code>
        <span v-else>选择后自动查找相关文件。</span>
      </div>
      <p v-if="finding" role="status">正在本地查找相关文件…</p>
      <fieldset v-if="discovery?.candidates.length" class="candidates" :disabled="busy">
        <legend>确认要发给 AI 的文件</legend>
        <label v-for="file in discovery.candidates" :key="file.path" class="candidate">
          <input v-model="checkedPaths" type="checkbox" :value="file.path">
          <span><code>{{ file.path }}</code><small>{{ file.reason }}</small></span>
        </label>
      </fieldset>
      <details v-if="repository" class="advanced" :open="advanced" @toggle="advanced = ($event.target as HTMLDetailsElement).open">
        <summary>高级选项</summary>
        <label><span>基准分支</span><input v-model.trim="branch" maxlength="200" placeholder="默认 HEAD" required :disabled="busy"></label>
        <label><span>手动补充</span><textarea v-model="files" rows="2" placeholder="每行一个仓库相对路径，例如 src/App.vue" :disabled="busy"></textarea></label>
        <button type="button" :disabled="busy || !branch" @click="findFiles">重新查找</button>
      </details>
      <div v-if="selectedFiles.length" class="analysis-scope">
        <p>已选 {{ selectedFiles.length }} / 6 个文件<span v-if="discovery"> · 提交 {{ discovery.commit.slice(0, 12) }}</span></p>
        <ul v-if="extraFiles.length">
          <li v-for="file in extraFiles" :key="file"><code>{{ file }}</code></li>
        </ul>
        <p>确认分析后，所选代码和 Jira 缺陷将发送给 <strong>{{ selectedModelName }}</strong>，网关 <span class="gateway">{{ gateway }}</span>。</p>
      </div>
    </template>
    <p v-if="!models.length && !busy">可在「接入设置 → AI 模型」配置多个模型供选择。</p>
    <div class="actions">
      <button class="primary" type="submit" :disabled="busy || !selected || (!manualHandoff && !canAnalyze)">{{ manualHandoff ? "复制交接内容" : "确认并分析" }}</button>
      <button type="button" :disabled="busy" @click="$emit('close')">收起</button>
    </div>
    <p v-if="message" role="status">{{ message }}</p>
    <div v-if="answer" class="answer">
      <strong>{{ answer.model || answer.requestedModel }}</strong>
      <p>{{ answer.text }}</p>
    </div>
  </form>
</template>

<style scoped>
.handoff {
  padding: 10px;
  margin-top: 8px;
  border: 1px solid #dce4ef;
  border-radius: 8px;
  background: #f7f9fd;
}

label {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
  font-size: 13px;
}

label span {
  flex: 0 0 64px;
}

input,
select,
textarea {
  flex: 1;
  min-width: 0;
  padding: 5px 6px;
  border: 1px solid #d3deed;
  border-radius: 6px;
  background: #fff;
  color: #222c38;
  font: inherit;
}

.repository-field button {
  flex-shrink: 0;
  margin: 0 0 0 6px;
}

.candidates {
  min-width: 0;
  margin: 8px 0;
  padding: 6px 8px;
  border: 1px solid #dce4ef;
  border-radius: 6px;
}

.candidate {
  align-items: flex-start;
}

.candidate input {
  flex: none;
  margin: 4px 8px 0 0;
}

.candidate span {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.candidate small {
  display: block;
  color: #536175;
}

.repository-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  margin: 6px 0;
  overflow-wrap: anywhere;
}

.repository-summary code,
.repository-summary span {
  min-width: 0;
  font-size: 12px;
}

.advanced {
  margin: 8px 0;
}

.advanced summary {
  margin-bottom: 6px;
  color: #536175;
  cursor: pointer;
}

.analysis-scope ul {
  margin: 4px 0;
  padding-left: 18px;
  overflow-wrap: anywhere;
}

p {
  margin: 6px 0;
  color: #536175;
  font-size: 13px;
  overflow-wrap: anywhere;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  margin-top: 8px;
}

button {
  margin-right: 6px;
  padding: 4px 9px;
  border: 1px solid #d3deed;
  border-radius: 6px;
  background: #fff;
  color: #222c38;
}

.primary {
  border-color: #3555c5;
  background: #3555c5;
  color: #fff;
}

button:disabled {
  opacity: 0.65;
}

.answer {
  margin-top: 8px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
