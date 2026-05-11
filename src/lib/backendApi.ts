import type {
  AdminUser,
  AdminApiChannel,
  ApiChannel,
  ApiChannelDraft,
  AppSettings,
  AuthSettings,
  AutoImportRun,
  AutoImportSettings,
  AutoImportSettingsPatch,
  AuditLog,
  BackendUser,
  ChannelLeaderboardItem,
  GenerationQueueStats,
  InviteCode,
  OpenPromptDiscovery,
  OpenPromptSourceStatus,
  OpenPromptPreview,
  PromptOptimizeResult,
  PromptTemplate,
  PromptTemplateDraft,
  ProjectBoard,
  ProjectBoardDraft,
  ServerAsset,
  GenerationPreflight,
  SystemBackupPreview,
  TaskRecord,
  TemplateSample,
  TemplateVersion,
  RegistrationMode,
} from '../types'

export type OpenPromptLibrarySourceId = 'evolink' | 'zerolu' | 'imgedify' | 'youmind' | 'nanobanana'

export const OPEN_PROMPT_LIBRARY_SOURCES: Array<{
  id: OpenPromptLibrarySourceId
  label: string
  licenseNote: string
}> = [
  {
    id: 'evolink',
    label: 'EvoLinkAI',
    licenseNote: 'README 标注 CC BY 4.0，仓库 LICENSE 为 Apache-2.0',
  },
  {
    id: 'zerolu',
    label: 'ZeroLu GPT Image',
    licenseNote: 'MIT',
  },
  {
    id: 'imgedify',
    label: 'ImgEdify GPT4o',
    licenseNote: 'MIT',
  },
  {
    id: 'youmind',
    label: 'YouMind GPT Image 2 (5000+)',
    licenseNote: 'CC BY 4.0',
  },
  {
    id: 'nanobanana',
    label: 'X/Twitter 热门 Prompt (1400+)',
    licenseNote: 'CC BY 4.0',
  },
]

function apiBase(): string {
  return '/api'
}

export function getHealth(): Promise<{ ok: boolean }> {
  return fetch(`${apiBase()}/health`, {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  }).then(async (response) => {
    if (!response.ok) {
      throw new Error(await readError(response))
    }
    return response.json() as Promise<{ ok: boolean }>
  })
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json()
    if (typeof body.detail === 'string') return body.detail
    if (body.detail) return JSON.stringify(body.detail)
    if (typeof body.message === 'string') return body.message
  } catch {
    try {
      return await response.text()
    } catch {
      /* ignore */
    }
  }
  return `HTTP ${response.status}`
}

async function request<T>(settings: AppSettings, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })

  if (!response.ok) {
    throw new Error(await readError(response))
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function getMe(settings: AppSettings): Promise<BackendUser> {
  return request(settings, '/auth/me')
}

export function getAuthSettings(settings: AppSettings): Promise<AuthSettings> {
  return request(settings, '/auth/settings')
}

export function login(settings: AppSettings, username: string, password: string): Promise<BackendUser> {
  return request(settings, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function register(
  settings: AppSettings,
  username: string,
  password: string,
  inviteCode?: string,
): Promise<BackendUser> {
  return request(settings, '/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password, inviteCode: inviteCode?.trim() || undefined }),
  })
}

export function logout(settings: AppSettings): Promise<{ ok: boolean }> {
  return request(settings, '/auth/logout', { method: 'POST' })
}

export function listChannels(settings: AppSettings): Promise<ApiChannel[]> {
  return request(settings, '/channels')
}

export function listProjects(settings: AppSettings): Promise<ProjectBoard[]> {
  return request(settings, '/projects')
}

export function createProject(settings: AppSettings, payload: ProjectBoardDraft): Promise<ProjectBoard> {
  return request(settings, '/projects', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function patchProject(
  settings: AppSettings,
  projectId: string,
  payload: Partial<ProjectBoardDraft>,
): Promise<ProjectBoard> {
  return request(settings, `/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function deleteProject(settings: AppSettings, projectId: string): Promise<{ ok: boolean }> {
  return request(settings, `/projects/${projectId}`, { method: 'DELETE' })
}

export function listChannelLeaderboard(settings: AppSettings): Promise<ChannelLeaderboardItem[]> {
  return request(settings, '/channels/leaderboard')
}

export function listAdminChannels(settings: AppSettings): Promise<AdminApiChannel[]> {
  return request(settings, '/admin/channels')
}

export function createChannel(settings: AppSettings, payload: ApiChannelDraft): Promise<AdminApiChannel> {
  return request(settings, '/admin/channels', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function patchChannel(
  settings: AppSettings,
  channelId: string,
  payload: Partial<ApiChannelDraft>,
): Promise<AdminApiChannel> {
  return request(settings, `/admin/channels/${channelId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function deleteChannel(settings: AppSettings, channelId: string): Promise<{ ok: boolean }> {
  return request(settings, `/admin/channels/${channelId}`, { method: 'DELETE' })
}

export function checkChannelHealth(settings: AppSettings, channelId: string): Promise<AdminApiChannel> {
  return request(settings, `/admin/channels/${channelId}/health-check`, { method: 'POST' })
}

export function checkChannelCompatibility(settings: AppSettings, channelId: string): Promise<AdminApiChannel> {
  return request(settings, `/admin/channels/${channelId}/compatibility-check`, { method: 'POST' })
}

export function listAuditLogs(settings: AppSettings, limit = 100): Promise<AuditLog[]> {
  return request(settings, `/admin/audit-logs?limit=${encodeURIComponent(String(limit))}`)
}

export function listAdminUsers(settings: AppSettings): Promise<AdminUser[]> {
  return request(settings, '/admin/users')
}

export function patchAdminUserRole(
  settings: AppSettings,
  userId: string,
  role: AdminUser['role'],
): Promise<AdminUser> {
  return request(settings, `/admin/users/${encodeURIComponent(userId)}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  })
}

export function getAdminAuthSettings(settings: AppSettings): Promise<AuthSettings> {
  return request(settings, '/admin/auth/settings')
}

export function patchAdminAuthSettings(
  settings: AppSettings,
  registrationMode: RegistrationMode,
): Promise<AuthSettings> {
  return request(settings, '/admin/auth/settings', {
    method: 'PATCH',
    body: JSON.stringify({ registrationMode }),
  })
}

export function listInviteCodes(settings: AppSettings): Promise<InviteCode[]> {
  return request(settings, '/admin/auth/invite-codes')
}

export function listInviteCodeUses(settings: AppSettings, inviteId: string, limit = 100): Promise<InviteCode['recentUses']> {
  return request(settings, `/admin/auth/invite-codes/${encodeURIComponent(inviteId)}/uses?limit=${encodeURIComponent(String(limit))}`)
}

export function createInviteCode(
  settings: AppSettings,
  payload: { note?: string; maxUses?: number | null; expiresAt?: number | null },
): Promise<InviteCode> {
  return request(settings, '/admin/auth/invite-codes', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function createInviteCodesBatch(
  settings: AppSettings,
  payload: { count: number; note?: string; maxUses?: number | null; expiresAt?: number | null },
): Promise<InviteCode[]> {
  return request(settings, '/admin/auth/invite-codes/batch', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function patchInviteCode(
  settings: AppSettings,
  inviteId: string,
  payload: { note?: string; maxUses?: number | null; expiresAt?: number | null; isEnabled?: boolean },
): Promise<InviteCode> {
  return request(settings, `/admin/auth/invite-codes/${encodeURIComponent(inviteId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function deleteInviteCode(settings: AppSettings, inviteId: string): Promise<{ ok: boolean }> {
  return request(settings, `/admin/auth/invite-codes/${encodeURIComponent(inviteId)}`, { method: 'DELETE' })
}

export async function exportSystemBackup(settings: AppSettings): Promise<Blob> {
  const response = await fetch(`${apiBase()}/admin/system/export`, {
    credentials: 'include',
    headers: { Accept: 'application/zip' },
  })
  if (!response.ok) throw new Error(await readError(response))
  return response.blob()
}

export function previewSystemBackup(settings: AppSettings, file: File): Promise<SystemBackupPreview> {
  const formData = new FormData()
  formData.append('file', file)
  return request(settings, '/admin/system/import-preview', {
    method: 'POST',
    body: formData,
  })
}

export function importSystemBackup(
  settings: AppSettings,
  file: File,
): Promise<{ ok: boolean; restorePointName: string }> {
  const formData = new FormData()
  formData.append('file', file)
  return request(settings, '/admin/system/import', {
    method: 'POST',
    body: formData,
  })
}

export function listTemplates(settings: AppSettings, scope: 'all' | 'mine' | 'public' = 'all'): Promise<PromptTemplate[]> {
  return request(settings, `/templates?scope=${encodeURIComponent(scope)}`)
}

export function listTemplateSubmissions(settings: AppSettings): Promise<PromptTemplate[]> {
  return request(settings, '/admin/template-submissions')
}

export function listOpenPromptSources(settings: AppSettings): Promise<OpenPromptSourceStatus[]> {
  return request(settings, '/admin/open-prompt-sources')
}

export function getAutoImportSettings(settings: AppSettings): Promise<AutoImportSettings> {
  return request(settings, '/admin/auto-import/settings')
}

export function patchAutoImportSettings(
  settings: AppSettings,
  payload: AutoImportSettingsPatch,
): Promise<AutoImportSettings> {
  return request(settings, '/admin/auto-import/settings', {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function runAutoImport(settings: AppSettings): Promise<AutoImportRun> {
  return request(settings, '/admin/auto-import/run', { method: 'POST' })
}

export function listAutoImportRuns(settings: AppSettings, limit = 20): Promise<AutoImportRun[]> {
  return request(settings, `/admin/auto-import/runs?limit=${encodeURIComponent(String(limit))}`)
}

export function listOpenPromptDiscoveries(settings: AppSettings, limit = 50): Promise<OpenPromptDiscovery[]> {
  return request(settings, `/admin/open-prompt-discoveries?limit=${encodeURIComponent(String(limit))}`)
}

export function previewOpenPromptLibraryTemplates(
  settings: AppSettings,
  source: OpenPromptLibrarySourceId,
  limit = 0,
): Promise<OpenPromptPreview> {
  return request(settings, `/admin/templates/import-open-library/preview?source=${encodeURIComponent(source)}&limit=${encodeURIComponent(String(limit))}`)
}

export function createTemplate(settings: AppSettings, template: PromptTemplateDraft): Promise<PromptTemplate> {
  return request(settings, '/templates', {
    method: 'POST',
    body: JSON.stringify(template),
  })
}

export function patchTemplate(
  settings: AppSettings,
  templateId: string,
  patch: Partial<PromptTemplateDraft>,
): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteTemplate(settings: AppSettings, templateId: string): Promise<{ ok: boolean }> {
  return request(settings, `/templates/${templateId}`, { method: 'DELETE' })
}

export function duplicateTemplate(settings: AppSettings, templateId: string): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}/duplicate`, { method: 'POST' })
}

export function setTemplateCover(settings: AppSettings, templateId: string, imageId: string): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}/set-cover`, {
    method: 'POST',
    body: JSON.stringify({ imageId }),
  })
}

export function markTemplateUsed(settings: AppSettings, templateId: string): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}/use`, { method: 'POST' })
}

export function rateTemplate(settings: AppSettings, templateId: string, score: number): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}/rate`, {
    method: 'POST',
    body: JSON.stringify({ score }),
  })
}

export function listTemplateSamples(settings: AppSettings, templateId: string, limit = 24): Promise<TemplateSample[]> {
  return request(settings, `/templates/${templateId}/samples?limit=${encodeURIComponent(String(limit))}`)
}

export function listTemplateVersions(settings: AppSettings, templateId: string): Promise<TemplateVersion[]> {
  return request(settings, `/templates/${templateId}/versions`)
}

export function restoreTemplateVersion(
  settings: AppSettings,
  templateId: string,
  versionId: string,
): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}/versions/${versionId}/restore`, { method: 'POST' })
}

export function listSimilarTemplates(
  settings: AppSettings,
  payload: { templateId?: string; assetId?: string; query?: string; limit?: number },
): Promise<PromptTemplate[]> {
  const params = new URLSearchParams()
  if (payload.templateId) params.set('templateId', payload.templateId)
  if (payload.assetId) params.set('assetId', payload.assetId)
  if (payload.query) params.set('query', payload.query)
  params.set('limit', String(payload.limit ?? 8))
  return request(settings, `/templates/similar?${params.toString()}`)
}

export function importTemplatePack(
  settings: AppSettings,
  templates: Array<Record<string, unknown>>,
): Promise<{ ok: boolean; created: number; skipped: number }> {
  return request(settings, '/templates/import-pack', {
    method: 'POST',
    body: JSON.stringify({ templates }),
  })
}

export function submitTemplate(settings: AppSettings, templateId: string): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}/submit`, { method: 'POST' })
}

export function approveTemplateSubmission(settings: AppSettings, templateId: string): Promise<PromptTemplate> {
  return request(settings, `/admin/template-submissions/${templateId}/approve`, { method: 'POST' })
}

export function rejectTemplateSubmission(
  settings: AppSettings,
  templateId: string,
  reason = '',
): Promise<PromptTemplate> {
  return request(settings, `/admin/template-submissions/${templateId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  })
}

export function importOpenPromptLibraryTemplates(
  settings: AppSettings,
  source: OpenPromptLibrarySourceId,
  limit = 0,
  selectedKeys: string[] = [],
): Promise<{ ok: boolean; source: string; created: number; updated: number; skipped: number }> {
  return request(settings, `/admin/templates/import-open-library?source=${encodeURIComponent(source)}&limit=${encodeURIComponent(String(limit))}`, {
    method: 'POST',
    body: JSON.stringify({ source, limit, selectedKeys }),
  })
}

export function importEvolinkTemplates(
  settings: AppSettings,
  limit = 0,
): Promise<{ ok: boolean; source: string; created: number; updated: number; skipped: number }> {
  return importOpenPromptLibraryTemplates(settings, 'evolink', limit)
}

export function listGenerations(settings: AppSettings): Promise<TaskRecord[]> {
  return request(settings, '/generations')
}

export function getGenerationQueueStats(settings: AppSettings): Promise<GenerationQueueStats> {
  return request(settings, '/generations/queue-stats')
}

export function getGenerationPreflight(
  settings: AppSettings,
  payload: {
    channelId: string
    model: string
    prompt: string
    params: TaskRecord['params']
    inputImageCount: number
    hasMask: boolean
  },
): Promise<GenerationPreflight> {
  return request(settings, '/generations/preflight', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getGeneration(settings: AppSettings, taskId: string): Promise<TaskRecord> {
  return request(settings, `/generations/${taskId}`)
}

export function deleteGeneration(settings: AppSettings, taskId: string): Promise<{ ok: boolean }> {
  return request(settings, `/generations/${taskId}`, { method: 'DELETE' })
}

export function cancelGeneration(settings: AppSettings, taskId: string): Promise<TaskRecord> {
  return request(settings, `/generations/${taskId}/cancel`, { method: 'POST' })
}

export function streamGeneration(
  taskId: string,
  onUpdate: (task: TaskRecord) => void,
  onError: (err: Error) => void,
): () => void {
  const url = `${apiBase()}/generations/${taskId}/stream`
  const eventSource = new EventSource(url, { withCredentials: true } as EventSourceInit)

  eventSource.addEventListener('status', (e: MessageEvent) => {
    try {
      const task = JSON.parse(e.data) as TaskRecord
      onUpdate(task)
    } catch (err) {
      onError(err instanceof Error ? err : new Error(String(err)))
      eventSource.close()
    }
  })

  eventSource.onerror = () => {
    eventSource.close()
    onError(new Error('SSE connection lost'))
  }

  return () => eventSource.close()
}

export async function getAssetDataUrl(settings: AppSettings, assetId: string): Promise<string> {
  const response = await fetch(`${apiBase()}/assets/${assetId}`, {
    credentials: 'include',
  })
  if (!response.ok) throw new Error(await readError(response))
  const blob = await response.blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}

export function copyAssetToSystemClipboard(
  settings: AppSettings,
  assetId: string,
): Promise<{ ok: boolean; method: string }> {
  return request(settings, `/assets/${assetId}/copy-to-clipboard`, { method: 'POST' })
}

export function optimizePrompt(
  settings: AppSettings,
  payload: { prompt: string; negativePrompt?: string | null; channelId?: string | null; model?: string | null },
): Promise<PromptOptimizeResult> {
  return request(settings, '/prompts/optimize', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export interface BackendGenerateRequest {
  taskId?: string
  templateId?: string
  templateVersionId?: string
  projectId?: string | null
  parentTaskId?: string | null
  experimentId?: string | null
  variationLabel?: string | null
  channelId: string
  model: string
  prompt: string
  params: TaskRecord['params']
  inputImageDataUrls: string[]
  maskDataUrl?: string
}

export interface BackendGenerateResponse {
  task: TaskRecord
  images: string[]
  outputAssets: ServerAsset[]
  actualParams?: Record<string, unknown> | null
  actualParamsList?: Array<Record<string, unknown> | null> | null
  revisedPrompts?: Array<string | null> | null
}

export function generate(settings: AppSettings, payload: BackendGenerateRequest): Promise<BackendGenerateResponse> {
  return request(settings, '/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function runGeneration(settings: AppSettings, payload: BackendGenerateRequest): Promise<{ task: TaskRecord }> {
  return request(settings, '/generations/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
