<script setup lang="ts">
import { computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, ref } from "vue"
import type { AttendanceDetail, AttendanceState, DeskState } from "../../shared/desk"
import { dateParts, monthLabel, splitDetail } from "./attendance-view.mjs"
import { parseMarkdownBlocks } from "./markdown"
import FaceMark from "./FaceMark.vue"
const IntegrationsPanel = defineAsyncComponent(() => import("./IntegrationsPanel.vue"))
const AISettings = defineAsyncComponent(() => import("./AISettings.vue"))

type DetailCard = {
  month: string
  count: number
  rows: Array<AttendanceDetail & {
    period: string
    amount: string
    notes: string
    dateView: ReturnType<typeof dateParts>
  }>
}

type Turn = {
  id: number
  role: "user" | "assistant"
  text: string
  model?: string
  card?: DetailCard | null
}

const avatarPresets = [
  { id: "preset:default", label: "经典分身" },
  { id: "preset:orbit", label: "亚华星轨" },
  { id: "preset:bot", label: "蓝釉机甲" },
  { id: "preset:owl", label: "夜航猫头鹰" },
  { id: "preset:cat", label: "办公小猫" }
]

const state = ref<DeskState | null>(null)
const command = ref("")
const settingsOpen = ref(false)
const settingsTab = ref("systems")
const aiBusy = ref(false)
const commandBusy = ref(false)
const pendingLabel = ref("正在处理")
const avatarMenuOpen = ref(false)
const avatarBusy = ref(false)
const avatarError = ref("")
const avatarAnchor = ref<HTMLElement | null>(null)
const thread = ref<HTMLElement | null>(null)
const turns = ref<Turn[]>([])
let turnId = 0
const prompts = [
  { label: "本月加班", command: "/加班" },
  { label: "刷新出勤", command: "/刷新" },
  { label: "打开消息", command: "/打开 工作消息" },
  { label: "工作任务", command: "/任务" }
]
let stopListening: (() => void) | null = null

const currentAvatar = computed(() => state.value?.avatar || "preset:default")
const faceBusy = computed(() => commandBusy.value || state.value?.attendance?.state === "loading")
const unappliedCount = computed(() => {
  const attendance = state.value?.attendance
  if (!attendance || attendance.state !== "ready") {
    return 0
  }
  if (typeof attendance.unappliedCount === "number") {
    return attendance.unappliedCount
  }
  return (attendance.details || []).filter((item) => !item.applied).length
})
const presence = computed(() => {
  if (commandBusy.value) {
    return pendingLabel.value
  }
  if (state.value?.attendance?.state === "loading") {
    return "正在读出勤"
  }
  if (unappliedCount.value > 0) {
    return `${unappliedCount.value} 条加班申请待核对`
  }
  return "可以交代事情"
})

function onDocumentPointerDown(event: MouseEvent): void {
  if (!avatarMenuOpen.value || !avatarAnchor.value) {
    return
  }
  const target = event.target as Node | null
  if (target && !avatarAnchor.value.contains(target)) {
    avatarMenuOpen.value = false
    avatarError.value = ""
  }
}

function onDocumentKeyDown(event: KeyboardEvent): void {
  if (event.key === "Escape" && avatarMenuOpen.value) {
    avatarMenuOpen.value = false
    avatarError.value = ""
  }
}

onMounted(async () => {
  window.addEventListener("mousedown", onDocumentPointerDown)
  window.addEventListener("keydown", onDocumentKeyDown)
  if (!window.desk) {
    return
  }
  stopListening = window.desk.onState(receiveState)
  receiveState(await window.desk.getState())
})

onUnmounted(() => {
  window.removeEventListener("mousedown", onDocumentPointerDown)
  window.removeEventListener("keydown", onDocumentKeyDown)
  if (stopListening) {
    stopListening()
  }
})

function toggleAvatarMenu(): void {
  avatarError.value = ""
  avatarMenuOpen.value = !avatarMenuOpen.value
}

async function pickAvatar(id: string): Promise<void> {
  if (!window.desk || avatarBusy.value) {
    return
  }
  avatarBusy.value = true
  avatarError.value = ""
  try {
    state.value = await window.desk.setAvatar(id)
    avatarMenuOpen.value = false
  } catch (error) {
    avatarError.value = error instanceof Error ? error.message : "更换头像失败"
  } finally {
    avatarBusy.value = false
  }
}

async function chooseLocalAvatar(): Promise<void> {
  if (!window.desk || avatarBusy.value) {
    return
  }
  avatarBusy.value = true
  avatarError.value = ""
  try {
    const updated = await window.desk.chooseAvatar()
    if (updated) {
      state.value = updated
      avatarMenuOpen.value = false
    }
  } catch (error) {
    avatarError.value = (error instanceof Error ? error.message : "更换头像失败").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")
  } finally {
    avatarBusy.value = false
  }
}

function clearTurns(): void {
  if (commandBusy.value) {
    return
  }
  turns.value = []
}

async function togglePanel(): Promise<void> {
  state.value = await window.desk.togglePanel()
}

function stopAI(): void { window.desk.cancelAI() }

function spokenCommand(input: string): string {
  if (input === "/加班") {
    return "看看本月加班"
  }
  if (input === "/刷新") {
    return "刷新出勤"
  }
  if (input === "/打开 工作消息" || input === "/打开 消息") {
    return "打开工作消息"
  }
  if (input === "/打开 首页") {
    return "打开首页"
  }
  if (input === "/帮助" || input === "/help") {
    return "你能做什么"
  }
  return input.replace(/^\//, "")
}

function resolveCommand(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim()
  if (!text || text.startsWith("/")) {
    return text
  }
  const compact = text.replace(/\s/g, "")
  if (/^(?:查看|看看|查询)?(?:我的)?任务(?:列表)?$/.test(compact)) return "/任务"
  if (/^(?:请)?(?:帮我)?(?:看看|查看|查一下)?(?:本月)?加班(?:情况|明细)?$/.test(compact)) {
    return "/加班"
  }
  if (/^刷新(?:一下)?(?:出勤|加班|统计)?$/.test(compact)) {
    return "/刷新"
  }
  if (/^打开(?:工作)?消息$/.test(compact)) {
    return "/打开 工作消息"
  }
  if (/^打开(?:oa|OA)?首页$/.test(compact)) {
    return "/打开 首页"
  }
  if (/^(?:帮助|你能做什么|你能做些什么|怎么用)$/.test(compact)) {
    return "/帮助"
  }
  const remind = /^(?:提醒我?|到点提醒)\s*(\d{1,2}:\d{2})\s+(\S(?:.*\S)?)$/.exec(text)
  if (remind) {
    return "/提醒 " + remind[1] + " " + remind[2]
  }
  const cancel = /^取消(?:提醒)?\s+(\S(?:.*\S)?)$/.exec(text)
  if (cancel) {
    return "/取消 " + cancel[1]
  }
  return ""
}

function buildCard(attendance: AttendanceState | undefined): DetailCard | null {
  if (!attendance || attendance.state !== "ready" || !attendance.details?.length) {
    return null
  }
  const rows = attendance.details.map((item) => ({
    ...item,
    ...splitDetail(item.text),
    dateView: dateParts(item.date)
  }))
  return {
    month: monthLabel(attendance.monthKey || ""),
    count: rows.length,
    rows
  }
}

function cardSummary(attendance: AttendanceState, card: DetailCard): string {
  const applied = card.rows.filter(row => row.applied).length
  return `本月打卡加班 ${attendance.totalText}。已申请 ${applied} 条，待核对 ${card.count - applied} 条。`
}

function receiveState(next: DeskState): void {
  state.value = next
  if (next.attendance?.state !== "ready" || !turns.value.some(turn => turn.card)) return
  const card = buildCard(next.attendance)
  if (!card) return
  for (const turn of turns.value) {
    if (turn.card?.month === card.month) {
      turn.card = card
      turn.text = cardSummary(next.attendance, card)
    }
  }
}

function pushTurn(role: "user" | "assistant", value: string, card?: DetailCard | null, model?: string): void {
  turnId += 1
  turns.value = [...turns.value, { id: turnId, role, text: value, card: card || null, model }]
}

async function scrollThread(): Promise<void> {
  await nextTick()
  if (thread.value) {
    thread.value.scrollTop = thread.value.scrollHeight
  }
}

async function runCommand(preset?: string): Promise<void> {
  const typed = (preset || command.value).trim()
  if (!typed || commandBusy.value || !window.desk) {
    return
  }
  const resolved = resolveCommand(typed)
  command.value = ""
  pushTurn("user", typed.startsWith("/") ? spokenCommand(typed) : typed)
  commandBusy.value = true
  pendingLabel.value = resolved === "/加班" || resolved === "/刷新" ? "正在看本月加班" : "正在处理"
  await scrollThread()
  try {
    if (!resolved) {
      aiBusy.value = true
      pendingLabel.value = "正在等待 AI 分析"
      const history = turns.value
        .slice(-9, -1)
        .filter((item) => item.text.trim())
        .map((item) => ({ role: item.role, text: item.text }))
      const answer = await window.desk.askAI({ text: typed, stage: "analysis", history })
      pushTurn("assistant", answer.text, null, answer.model)
      return
    }
    const result = await window.desk.runCommand(resolved)
    const wantsCard = resolved === "/加班" || resolved === "/刷新"
    if (wantsCard) {
      state.value = await window.desk.getState()
    }
    const card = wantsCard ? buildCard(state.value?.attendance) : null
      pushTurn("assistant", card && state.value ? cardSummary(state.value.attendance, card) : result.message, card)
  } catch (error) {
    pushTurn("assistant", (error instanceof Error ? error.message : "请求失败，请重试").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""))
  } finally {
    aiBusy.value = false
    commandBusy.value = false
    pendingLabel.value = "正在处理"
    await scrollThread()
  }
}
</script>

<template>
  <div class="shell">
    <svg class="icon-definitions" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <symbol id="i-collapse" viewBox="0 0 24 24"><path d="m8 6 6 6-6 6M19 5v14" /></symbol>
      <symbol id="i-send" viewBox="0 0 24 24"><path d="M12 19V6M7 11l5-5 5 5" /></symbol>
      <symbol id="i-stop" viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none" /></symbol>
    </svg>
    <header class="colleague">
      <div ref="avatarAnchor" class="avatar-anchor">
        <button
          class="avatar-trigger"
          type="button"
          title="更换分身头像"
          aria-label="更换分身头像"
          :aria-expanded="avatarMenuOpen"
          @click="toggleAvatarMenu"
        >
          <FaceMark :avatar="currentAvatar" :busy="faceBusy" />
          <span class="avatar-edit-dot" aria-hidden="true"></span>
        </button>
        <div v-if="avatarMenuOpen" class="avatar-popover" role="dialog" aria-label="选择分身头像">
          <div class="avatar-popover-title">更换分身头像</div>
          <div class="avatar-presets">
            <button
              v-for="preset in avatarPresets"
              :key="preset.id"
              type="button"
              class="avatar-choice"
              :class="{ selected: currentAvatar === preset.id }"
              :title="preset.label"
              :aria-label="preset.label"
              :disabled="avatarBusy"
              @click="pickAvatar(preset.id)"
            >
              <FaceMark :avatar="preset.id" />
            </button>
          </div>
          <div class="avatar-actions">
            <button type="button" class="avatar-upload" :disabled="avatarBusy" @click="chooseLocalAvatar">上传本地图片…</button>
            <button v-if="currentAvatar !== 'preset:default'" type="button" class="avatar-reset" :disabled="avatarBusy" @click="pickAvatar('preset:default')">恢复默认</button>
          </div>
          <p v-if="avatarError" class="avatar-error" role="status">{{ avatarError }}</p>
        </div>
      </div>
      <div class="colleague-copy">
        <strong class="colleague-name">分身</strong>
        <span class="colleague-status" :class="{ 'is-alert': unappliedCount > 0 }">{{ presence }}</span>
      </div>
      <button v-if="unappliedCount > 0 && !settingsOpen" class="unapplied-pill" type="button" title="点击查看本月尚未匹配到申请的记录" @click="runCommand('/加班')">待核对 {{ unappliedCount }}</button>
      <button v-if="!settingsOpen && turns.length && !commandBusy" class="header-ghost" type="button" @click="clearTurns">清空</button>
      <button class="settings-entry" type="button" @click="settingsOpen = !settingsOpen">{{ settingsOpen ? '返回对话' : '接入设置' }}</button>
      <button class="icon-button" type="button" title="关闭分身" aria-label="关闭分身" @click="togglePanel">
        <svg class="icon" aria-hidden="true"><use href="#i-collapse" /></svg>
      </button>
    </header>
    <template v-if="settingsOpen">
      <nav class="settings-tabs" aria-label="接入设置分类">
        <button type="button" :class="{ selected: settingsTab === 'systems' }" @click="settingsTab = 'systems'">任务系统</button>
        <button type="button" :class="{ selected: settingsTab === 'ai' }" @click="settingsTab = 'ai'">AI 模型</button>
      </nav>
      <IntegrationsPanel v-if="settingsTab === 'systems'" />
      <AISettings v-else />
    </template>
    <template v-else>
    <div ref="thread" class="thread" aria-label="和分身的对话">
      <div v-if="!turns.length" class="opening-card">
        <FaceMark :avatar="currentAvatar" />
        <p class="opening">可以直接交代加班和提醒。</p>
        <p class="opening-sub">支持查询本月加班、设置本机提醒，或直接向分身提问和梳理任务。</p>
        <button v-if="unappliedCount > 0" class="opening-alert" type="button" @click="runCommand('/加班')">
          <span class="opening-alert-tag">申请待核对</span>
          <span class="opening-alert-text">本月有 {{ unappliedCount }} 条加班尚未匹配到申请，点击查看明细</span>
        </button>
      </div>
      <div v-for="(turn, index) in turns" :key="turn.id" class="turn" :class="turn.role">
        <p v-if="turn.role === 'user'">{{ turn.text }}</p>
        <template v-else>
          <div class="assistant-content" :aria-live="index === turns.length - 1 ? 'polite' : 'off'">
            <template v-for="(block, bIdx) in parseMarkdownBlocks(turn.text)" :key="bIdx">
              <h4 v-if="block.type === 'heading'" class="md-heading">
                <template v-for="(tok, tIdx) in block.tokens" :key="tIdx">
                  <strong v-if="tok.type === 'bold'">{{ tok.text }}</strong>
                  <code v-else-if="tok.type === 'code'" class="md-inline-code">{{ tok.text }}</code>
                  <template v-else>{{ tok.text }}</template>
                </template>
              </h4>
              <pre v-else-if="block.type === 'code'" class="md-code-block"><code>{{ block.text }}</code></pre>
              <component :is="block.ordered ? 'ol' : 'ul'" v-else-if="block.type === 'list'" class="md-list">
                <li v-for="(itemTokens, iIdx) in block.items" :key="iIdx">
                  <template v-for="(tok, tIdx) in itemTokens" :key="tIdx">
                    <strong v-if="tok.type === 'bold'">{{ tok.text }}</strong>
                    <code v-else-if="tok.type === 'code'" class="md-inline-code">{{ tok.text }}</code>
                    <template v-else>{{ tok.text }}</template>
                  </template>
                </li>
              </component>
              <p v-else class="md-para">
                <template v-for="(lineTokens, lIdx) in block.lines" :key="lIdx">
                  <br v-if="lIdx > 0" />
                  <template v-for="(tok, tIdx) in lineTokens" :key="tIdx">
                    <strong v-if="tok.type === 'bold'">{{ tok.text }}</strong>
                    <code v-else-if="tok.type === 'code'" class="md-inline-code">{{ tok.text }}</code>
                    <template v-else>{{ tok.text }}</template>
                  </template>
                </template>
              </p>
            </template>
          </div>
          <div v-if="turn.card" class="record" aria-label="加班明细">
            <div class="record-head">
              <span>{{ turn.card.month }}</span>
              <span class="record-summary">
                <span>{{ turn.card.count }} 条</span>
                <span v-if="turn.card.rows.some((row) => !row.applied)" class="record-unapplied">{{ turn.card.rows.filter((row) => !row.applied).length }} 条待核对</span>
              </span>
            </div>
            <ul class="detail-list">
              <li v-for="item in turn.card.rows" :key="item.id" class="detail" :class="{ 'is-unapplied': !item.applied }">
                <span v-if="item.dateView" class="detail-date" :aria-label="item.dateView.ariaLabel">
                  <span class="detail-date-day">{{ item.dateView.day }}</span>
                  <span class="detail-date-month">{{ item.dateView.monthLabel }}</span>
                </span>
                <span v-else class="detail-date">{{ item.date }}</span>
                <div class="detail-body">
                  <div class="detail-heading">
                    <span class="detail-period">打卡 {{ item.period }}</span>
                    <span v-if="item.amount" class="detail-amount">{{ item.amount }}</span>
                  </div>
                  <div class="detail-meta">
                    <span v-if="item.notes" class="detail-note">{{ item.notes }}</span>
                    <span v-if="item.applied" class="application-badge" title="OA 出勤记录已关联加班申请（审批中或已通过）">已申请</span>
                    <span v-else class="unapplied-badge" title="尚未匹配到这一天的加班申请">待核对</span>
                    <span v-if="item.applicationPeriod" class="detail-note">申请时段 {{ item.applicationPeriod }}</span>
                  </div>
                </div>
              </li>
            </ul>
          </div>
          <div v-if="turn.model" class="turn-meta">响应模型 · {{ turn.model }}</div>
        </template>
      </div>
      <div v-if="commandBusy" class="turn assistant pending" role="status">
        <div class="typing-indicator">
          <span class="typing-dots" aria-hidden="true"><span></span><span></span><span></span></span>
          <span>{{ pendingLabel }}</span>
        </div>
      </div>
    </div>
    <div class="dock">
      <div v-if="!turns.length" class="prompts">
        <button v-for="item in prompts" :key="item.command" type="button" :disabled="commandBusy" @click="runCommand(item.command)">
          {{ item.label }}
        </button>
      </div>
      <form class="composer" @submit.prevent="runCommand()">
        <input
          id="assistant-command"
          v-model="command"
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder="给分身发消息"
          :disabled="commandBusy"
        />
        <button v-if="aiBusy" class="stop" type="button" title="停止生成" aria-label="停止生成" @click="stopAI">
          <svg class="icon" aria-hidden="true"><use href="#i-stop" /></svg>
        </button>
        <button v-else class="send" type="submit" aria-label="发送" :disabled="commandBusy || !command.trim()">
          <svg class="icon" aria-hidden="true"><use href="#i-send" /></svg>
        </button>
      </form>
    </div>
    </template>
  </div>
</template>
