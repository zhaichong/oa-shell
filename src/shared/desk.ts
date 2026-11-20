export interface AttendanceDetail {
  id: string
  date: string
  text: string
  applied?: boolean
  applicationPeriod?: string
}

export interface AttendanceState {
  state: string
  message: string
  monthKey: string
  totalText: string
  totalLabel: string
  unappliedCount?: number
  details: AttendanceDetail[]
}

export interface AssistantReply {
  ok: boolean
  message: string
  bugLists?: JiraBugList[]
}

export interface JiraBugCursor { offset: number; token?: string }
export interface JiraBugFilter { mine: boolean; by: "title" | "key"; value: string }

export interface JiraBugList {
  connectionId: string
  name: string
  items: Array<{ id: string; title: string; reporter: string; created: string; status: string; description?: string }>
  total: number | null
  next: JiraBugCursor | null
  filter?: JiraBugFilter
  detailOnly?: boolean
  error?: string
}

export interface DeskState {
  panelOpen: boolean
  avatar?: string
  oa?: {
    state?: string
    message?: string
  }
  attendance: AttendanceState
  [key: string]: unknown
}

export interface DeskApi {
  getState: () => Promise<DeskState>
  restoreAssistantSession: () => Promise<string | null>
  togglePanel: () => Promise<DeskState>
  setAvatar: (avatar: string) => Promise<DeskState>
  chooseAvatar: () => Promise<DeskState | null>
  runCommand: (input: string) => Promise<AssistantReply>
  listJiraBugs: (id: string, cursor: JiraBugCursor, filter?: JiraBugFilter) => Promise<JiraBugList>
  getJiraBug: (id: string, key: string) => Promise<JiraBugList>
  openJiraBug: (id: string, key: string) => Promise<void>
  getJiraAIOptions: () => Promise<{ models: AIModel[]; gateway: string }>
  chooseJiraRepository: () => Promise<string | null>
  findJiraCode: (input: { id: string; key: string; repository: string; branch: string }) => Promise<JiraCodeDiscovery>
  analyzeJiraBug: (input: { id: string; key: string; model: string; gateway: string; repository: string; branch: string; commit?: string; files: string[] }) => Promise<AIReply>
  copyJiraHandoff: (input: { id: string; key: string; repository: string; branch: string }) => Promise<void>
  listConnections: () => Promise<ConnectionConfig[]>
  saveConnection: (input: ConnectionDraft) => Promise<ConnectionConfig>
  removeConnection: (id: string) => Promise<boolean>
  previewConnection: (id: string) => Promise<TaskPreview>
  loginConnection: (id: string) => Promise<boolean>
  getAIConfig: () => Promise<AIConfig>
  saveAIConfig: (input: AIConfig & { apiKey?: string; clearApiKey?: boolean }) => Promise<AIConfig>
  listAIModels: (input?: Partial<AIConfig> & { apiKey?: string }) => Promise<AIModel[]>
  listCachedAIModels?: () => Promise<AIModel[]>
  probeAI: () => Promise<AIReply>
  testAIChat?: (stage?: string) => Promise<AIReply>
  askAI: (input: { text: string; stage?: string; history?: Array<{ role: "user" | "assistant"; text: string }> }) => Promise<AIReply>
  cancelAI: () => Promise<boolean>
  getAIHistory: () => Promise<AIRecord[]>
  chooseCodex: () => Promise<string | null>
  runAISandbox: () => Promise<AISandboxResult>
  onState: (callback: (state: DeskState) => void) => () => void
}

export interface AIConfig {
  enabled: boolean
  provider: "magpie" | "compatible"
  baseUrl: string
  protocol: "chat" | "responses"
  auth: "none" | "bearer"
  allowHttp: boolean
  defaultModel: string
  analysisModel: string
  codingModel: string
  reviewModel: string
  executorPath: string
  timeoutSeconds: number
  outputLimit: number
  metadataRetries: number
  keyConfigured?: boolean
}

export interface AIModel { id: string; name: string; provider: string }
export interface JiraCodeDiscovery {
  commit: string
  candidates: Array<{ path: string; reason: string; selected: boolean }>
}
export interface AIReply { text: string; model: string; requestedModel: string; requestId: string; inputTokens: number | null; outputTokens: number | null }
export interface AIRecord { id: string; at: string; stage: string; requestedModel: string; model: string; status: string; durationMs: number; inputTokens: number | null; outputTokens: number | null }
export interface AISandboxResult { id: string; workspace: string; requestedModel: string; ok: boolean; message: string; durationMs: number }

export interface ConnectionConfig {
  bugType?: string
  id: string
  name: string
  kind: "jira-cloud" | "jira-server" | "qianfan" | "json"
  baseUrl: string
  allowHttp: boolean
  auth: "none" | "browser" | "bearer" | "basic" | "header"
  username: string
  headerName: string
  endpoint: string
  query: string
  mappings: Record<string, string>
  secretConfigured?: boolean
}

export type ConnectionDraft = ConnectionConfig & { secret?: string; clearSecret?: boolean }

export interface TaskPreview {
  items: Array<{ id: string; title: string; status: string; assignee: string; priority: string; url: string; reporter?: string; created?: string }>
  total: number | null
  hasMore: boolean
}
