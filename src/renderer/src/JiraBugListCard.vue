<script setup lang="ts">
import { ref } from "vue"
import type { JiraBugFilter, JiraBugList } from "../../shared/desk"
import JiraBugHandoff from "./JiraBugHandoff.vue"

const props = defineProps<{ list: JiraBugList }>()
const emit = defineEmits<{ update: [list: JiraBugList] }>()
const busy = ref(false)
const error = ref("")
const handoff = ref("")
const draft = ref<JiraBugFilter>({ ...(props.list.filter || { mine: true, by: "title", value: "" }) })
const formatter = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" })

function formatTime(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "未知" : formatter.format(date)
}

async function query(append = false): Promise<void> {
  if ((append && !props.list.next) || busy.value) return
  busy.value = true
  error.value = ""
  try {
    const cursor = append && props.list.next ? { ...props.list.next } : { offset: 0 }
    const filter = append ? props.list.filter : draft.value
    const page = await window.desk.listJiraBugs(props.list.connectionId, cursor, filter ? { ...filter, value: filter.value.trim() } : undefined)
    const seen = new Set(props.list.items.map(item => item.id))
    const items = append ? [...props.list.items, ...page.items.filter(item => !seen.has(item.id))] : page.items
    emit("update", { ...page, items, error: undefined })
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "读取失败，请重试。"
  } finally {
    busy.value = false
  }
}

async function open(key: string): Promise<void> {
  error.value = ""
  try {
    await window.desk.openJiraBug(props.list.connectionId, key)
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "无法打开 Jira 原单。"
  }
}

async function detail(key: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ""
  try {
    const result = await window.desk.getJiraBug(props.list.connectionId, key)
    const issue = result.items.find(item => item.id === key)
    if (!issue) throw new Error("找不到该缺陷，或当前账号无权读取。")
    emit("update", { ...props.list, items: props.list.items.map(item => item.id === key ? issue : item) })
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : "读取缺陷详情失败。"
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="bug-list" :aria-label="list.name + ' 缺陷列表'">
    <header class="bug-header">
      <strong>{{ list.name }}</strong>
      <span v-if="!list.error">{{ list.items.length }} 条<span v-if="list.total !== null"> / 共 {{ list.total }} 条</span></span>
    </header>
    <form v-if="!list.detailOnly" class="bug-search" @submit.prevent="query()">
      <label class="bug-mine"><input v-model="draft.mine" type="checkbox" :disabled="busy" @change="query()">只看我的</label>
      <div class="bug-search-fields">
        <select v-model="draft.by" aria-label="查找方式" :disabled="busy">
          <option value="title">按标题</option>
          <option value="key">按编号</option>
        </select>
        <input v-model="draft.value" type="search" maxlength="160" :disabled="busy" :aria-label="draft.by === 'key' ? 'Bug 编号' : '标题关键词'" :placeholder="draft.by === 'key' ? '例如 ABC-123' : '输入标题关键词'">
        <button class="bug-submit" type="submit" :disabled="busy">查询</button>
      </div>
      <p v-if="!list.filter" class="bug-search-note">当前按保存的条件显示。手动查询使用上方条件。</p>
    </form>
    <p v-if="list.error || error" class="bug-message is-error" role="status">{{ error || list.error }}</p>
    <p v-if="!list.error && !list.items.length" class="bug-message">当前筛选没有缺陷。</p>
    <ul v-if="list.items.length">
      <li v-for="item in list.items" :key="item.id">
        <div class="bug-row">
          <button class="bug-key" type="button" :title="'打开 Jira 原单 ' + item.id" @click="open(item.id)">{{ item.id }}</button>
          <span v-if="item.status" class="bug-status">{{ item.status }}</span>
        </div>
        <button v-if="item.description === undefined" class="bug-title" type="button" :disabled="busy" @click="detail(item.id)">{{ item.title }}</button>
        <strong v-else class="bug-title">{{ item.title }}</strong>
        <div class="bug-meta">
          <span>提出人 {{ item.reporter || "未知" }}</span>
          <span>提出时间 {{ formatTime(item.created) }}</span>
        </div>
        <p v-if="item.description !== undefined" class="bug-description">{{ item.description || "此缺陷没有描述。" }}</p>
        <button v-if="handoff !== item.id" class="bug-more bug-handoff" type="button" @click="handoff = item.id">交给 AI</button>
        <JiraBugHandoff v-else :connection-id="list.connectionId" :bug-key="item.id" @close="handoff = ''" />
      </li>
    </ul>
    <button v-if="list.next" class="bug-more" type="button" :disabled="busy" @click="query(true)">{{ busy ? "正在读取…" : "加载更多" }}</button>
  </section>
</template>

<style scoped>
.bug-list {
  margin-top: 8px;
  overflow: hidden;
  background: #fff;
  border: 1px solid #dce4ef;
  border-radius: 10px;
  color: #222c38;
}

.bug-header,
.bug-row,
.bug-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
}

.bug-header {
  padding: 10px 12px;
  background: #f5f7fc;
}

.bug-search {
  padding: 8px 12px 10px;
  background: #fafbfe;
}

.bug-mine,
.bug-search-fields {
  display: flex;
  align-items: center;
}

.bug-mine {
  width: fit-content;
  margin-bottom: 7px;
  font-size: 13px;
}

.bug-mine input {
  margin: 0 6px 0 0;
  accent-color: #3555c5;
}

.bug-search-fields select,
.bug-search-fields input,
.bug-submit {
  min-height: 30px;
  border: 1px solid #dce4ef;
  border-radius: 6px;
  font: inherit;
}

.bug-search-fields select,
.bug-search-fields input {
  margin-right: 6px;
  padding: 3px 5px;
  background: #fff;
  color: #222c38;
}

.bug-search-fields input {
  flex: 1;
  min-width: 0;
}

.bug-submit {
  flex-shrink: 0;
  padding: 3px 8px;
  background: #3555c5;
  color: #fff;
  cursor: pointer;
}

.bug-submit:disabled {
  opacity: 0.7;
  cursor: wait;
}

.bug-search-note {
  margin: 6px 0 0;
  color: #536175;
  font-size: 12px;
}

.bug-header span,
.bug-meta,
.bug-status {
  color: #536175;
  font-size: 12px;
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

li {
  padding: 10px 12px;
  border-top: 1px solid #e7ecf3;
}

.bug-key,
.bug-title,
.bug-more {
  border: 0;
  font: inherit;
  cursor: pointer;
}

.bug-key {
  padding: 2px 6px;
  border-radius: 5px;
  background: #eaf0fc;
  color: #2b46a7;
  font-size: 12px;
  font-weight: 600;
}

.bug-title {
  display: block;
  padding: 0;
  margin: 6px 0 4px;
  background: transparent;
  color: inherit;
  text-align: left;
  font-weight: 600;
  overflow-wrap: anywhere;
}

strong.bug-title {
  cursor: inherit;
}

button.bug-title:hover,
.bug-key:hover {
  color: #253c91;
  text-decoration: underline;
}

.bug-meta span {
  margin-right: 8px;
}

.bug-message,
.bug-more {
  margin: 8px 12px;
}

.is-error {
  color: #9b3029;
}

.bug-more {
  padding: 4px 8px;
  border-radius: 5px;
  background: #eaf0fc;
  color: #2b46a7;
}

.bug-description {
  margin: 8px 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.bug-handoff {
  margin-left: 0;
}
</style>
