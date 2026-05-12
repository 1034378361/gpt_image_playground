import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AdminUser,
  AdminApiChannel,
  ApiChannel,
  ApiChannelDraft,
  AppSettings,
  AuditLog,
  TaskParams,
  GenerationPreflight,
  InputImage,
  MaskDraft,
  ProjectBoard,
  TaskRecord,
  TaskStatus,
  PromptTemplate,
  PromptTemplateDraft,
  TemplateFilters,
  BackendUser,
  OpenPromptSourceStatus,
  ChannelLeaderboardItem,
  GenerationQueueStats,
} from './types'
import { DEFAULT_SETTINGS, DEFAULT_PARAMS } from './types'
import {
  getAllTasks,
  getAllTemplates,
  putTask,
  putTemplate,
  deleteTask as dbDeleteTask,
  clearTasks as dbClearTasks,
  clearTemplates as dbClearTemplates,
  getImage,
  getAllImages,
  putImage,
  deleteImage,
  clearImages,
  storeImage,
  hashDataUrl,
} from './lib/db'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { normalizeImageSize } from './lib/size'
import {
  composeTemplatePrompt,
  extractTemplateVariables,
  formFieldsToVariableDefinitions,
  isApprovedPublicTemplate,
  normalizeSelectedProjectId,
  normalizeTemplateDraft,
} from './lib/templateUtils'
import * as backendApi from './lib/backendApi'
import { canManageSystem } from './lib/roles'

// ===== Image cache =====
// 内存 LRU 缓存，id → dataUrl，避免每次从 IndexedDB 读取

const IMAGE_CACHE_MAX = 100

class LRUImageCache {
  private map = new Map<string, string>()

  get(id: string): string | undefined {
    const value = this.map.get(id)
    if (value !== undefined) {
      this.map.delete(id)
      this.map.set(id, value)
    }
    return value
  }

  has(id: string): boolean {
    return this.map.has(id)
  }

  set(id: string, dataUrl: string): void {
    if (this.map.has(id)) this.map.delete(id)
    this.map.set(id, dataUrl)
    while (this.map.size > IMAGE_CACHE_MAX) {
      const oldest = this.map.keys().next().value
      if (oldest !== undefined) this.map.delete(oldest)
    }
  }

  delete(id: string): void {
    this.map.delete(id)
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }
}

export const imageCache = new LRUImageCache()

export function getCachedImage(id: string): string | undefined {
  return imageCache.get(id)
}

export async function ensureImageCached(id: string): Promise<string | undefined> {
  if (imageCache.has(id)) return imageCache.get(id)
  const rec = await getImage(id)
  if (rec) {
    imageCache.set(id, rec.dataUrl)
    return rec.dataUrl
  }
  if (useStore.getState().backendUser) {
    try {
      const dataUrl = await backendApi.getAssetDataUrl(useStore.getState().settings, id)
      imageCache.set(id, dataUrl)
      await putImage({ id, dataUrl, createdAt: Date.now(), source: 'generated' })
      return dataUrl
    } catch {
      /* Local-only image ids and missing remote assets are expected sometimes. */
    }
  }
  return undefined
}

// ===== Store 类型 =====

interface AppState {
  // 设置
  settings: AppSettings
  setSettings: (s: Partial<AppSettings>) => void
  backendUser: BackendUser | null
  setBackendUser: (user: BackendUser | null) => void
  backendReady: boolean
  setBackendReady: (ready: boolean) => void
  backendUnavailableReason: string | null
  setBackendUnavailableReason: (reason: string | null) => void
  channels: ApiChannel[]
  setChannels: (channels: ApiChannel[]) => void
  adminChannels: AdminApiChannel[]
  setAdminChannels: (channels: AdminApiChannel[]) => void
  adminUsers: AdminUser[]
  setAdminUsers: (users: AdminUser[]) => void
  auditLogs: AuditLog[]
  setAuditLogs: (logs: AuditLog[]) => void
  openPromptSources: OpenPromptSourceStatus[]
  setOpenPromptSources: (sources: OpenPromptSourceStatus[]) => void
  channelLeaderboard: ChannelLeaderboardItem[]
  setChannelLeaderboard: (items: ChannelLeaderboardItem[]) => void
  queueStats: GenerationQueueStats | null
  setQueueStats: (stats: GenerationQueueStats | null) => void
  templateSubmissions: PromptTemplate[]
  setTemplateSubmissions: (templates: PromptTemplate[]) => void
  projects: ProjectBoard[]
  setProjects: (projects: ProjectBoard[]) => void
  currentProjectId: string | null
  setCurrentProjectId: (projectId: string | null) => void
  pendingParentTaskId: string | null
  setPendingParentTaskId: (taskId: string | null) => void
  generationPreflight: GenerationPreflight | null
  setGenerationPreflight: (preflight: GenerationPreflight | null) => void
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void
  composerRevealTick: number
  requestComposerReveal: () => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
  composerClearMode: 'prompt_only' | 'prompt_and_images' | 'keep_all'
  setComposerClearMode: (mode: AppState['composerClearMode']) => void
  theme: 'system' | 'light' | 'dark'
  setTheme: (theme: AppState['theme']) => void
  inputImages: InputImage[]
  addInputImage: (img: InputImage) => void
  removeInputImage: (idx: number) => void
  clearInputImages: () => void
  setInputImages: (imgs: InputImage[]) => void
  maskDraft: MaskDraft | null
  setMaskDraft: (draft: MaskDraft | null) => void
  clearMaskDraft: () => void
  maskEditorImageId: string | null
  setMaskEditorImageId: (id: string | null) => void

  // 参数
  params: TaskParams
  setParams: (p: Partial<TaskParams>) => void

  // 模板库
  currentView: 'tasks' | 'templates'
  setCurrentView: (view: AppState['currentView']) => void
  templates: PromptTemplate[]
  setTemplates: (templates: PromptTemplate[]) => void
  templateFilters: TemplateFilters
  setTemplateFilters: (filters: Partial<TemplateFilters>) => void
  selectedTemplateId: string | null
  setSelectedTemplateId: (id: string | null) => void
  selectedTemplateIds: string[]
  setSelectedTemplateIds: (ids: string[]) => void
  templateEditor:
    | { mode: 'create' }
    | { mode: 'fromCurrent' }
    | { mode: 'fromTask'; taskId: string }
    | { mode: 'edit'; templateId: string }
    | null
  setTemplateEditor: (editor: AppState['templateEditor']) => void
  templateVariableTemplateId: string | null
  setTemplateVariableTemplateId: (id: string | null) => void
  activeTemplateId: string | null
  setActiveTemplateId: (id: string | null) => void

  // 任务列表
  tasks: TaskRecord[]
  setTasks: (t: TaskRecord[]) => void

  // 搜索和筛选
  searchQuery: string
  setSearchQuery: (q: string) => void
  filterStatus: 'all' | TaskStatus
  setFilterStatus: (status: AppState['filterStatus']) => void
  filterFavorite: boolean
  setFilterFavorite: (f: boolean) => void

  // 多选
  selectedTaskIds: string[]
  setSelectedTaskIds: (ids: string[] | ((prev: string[]) => string[])) => void
  toggleTaskSelection: (id: string, force?: boolean) => void
  clearSelection: () => void

  // UI
  detailTaskId: string | null
  setDetailTaskId: (id: string | null) => void
  lightboxImageId: string | null
  lightboxImageList: string[]
  setLightboxImageId: (id: string | null, list?: string[]) => void
  showProjectManager: boolean
  setShowProjectManager: (show: boolean) => void
  showSettings: boolean
  setShowSettings: (v: boolean) => void
  showUserSettings: boolean
  setShowUserSettings: (v: boolean) => void

  // Toast
  toast: { message: string; type: 'info' | 'success' | 'error' } | null
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    confirmText?: string
    confirmKeyword?: string
    confirmHint?: string
    messageAlign?: 'left' | 'center'
    tone?: 'danger' | 'warning'
    action: () => void
    cancelAction?: () => void
  } | null
  setConfirmDialog: (d: AppState['confirmDialog']) => void
}

export const useStore = create<AppState>()(
  persist(
    (set, get) => ({
      // Settings
      settings: { ...DEFAULT_SETTINGS },
      setSettings: (s) => set((st) => ({
        settings: (() => {
          const next = { ...st.settings, ...s }
          return {
            channelId: typeof next.channelId === 'string' ? next.channelId : DEFAULT_SETTINGS.channelId,
            model: typeof next.model === 'string' ? next.model : DEFAULT_SETTINGS.model,
            apiMode:
              next.apiMode === 'images' || next.apiMode === 'responses'
                ? next.apiMode
                : DEFAULT_SETTINGS.apiMode,
            codexCli: typeof next.codexCli === 'boolean' ? next.codexCli : DEFAULT_SETTINGS.codexCli,
          }
        })(),
      })),
      backendUser: null,
      setBackendUser: (backendUser) => set({ backendUser }),
      backendReady: false,
      setBackendReady: (backendReady) => set({ backendReady }),
      backendUnavailableReason: null,
      setBackendUnavailableReason: (backendUnavailableReason) => set({ backendUnavailableReason }),
      channels: [],
      setChannels: (channels) => set({ channels }),
      adminChannels: [],
      setAdminChannels: (adminChannels) => set({ adminChannels }),
      adminUsers: [],
      setAdminUsers: (adminUsers) => set({ adminUsers }),
      auditLogs: [],
      setAuditLogs: (auditLogs) => set({ auditLogs }),
      openPromptSources: [],
      setOpenPromptSources: (openPromptSources) => set({ openPromptSources }),
      channelLeaderboard: [],
      setChannelLeaderboard: (channelLeaderboard) => set({ channelLeaderboard }),
      queueStats: null,
      setQueueStats: (queueStats) => set({ queueStats }),
      templateSubmissions: [],
      setTemplateSubmissions: (templateSubmissions) => set({ templateSubmissions }),
      projects: [],
      setProjects: (projects) => set({ projects }),
      currentProjectId: null,
      setCurrentProjectId: (currentProjectId) => set({ currentProjectId }),
      pendingParentTaskId: null,
      setPendingParentTaskId: (pendingParentTaskId) => set({ pendingParentTaskId }),
      generationPreflight: null,
      setGenerationPreflight: (generationPreflight) => set({ generationPreflight }),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),
      composerRevealTick: 0,
      requestComposerReveal: () => set((st) => ({ composerRevealTick: st.composerRevealTick + 1 })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set({ prompt }),
      composerClearMode: 'prompt_only',
      setComposerClearMode: (composerClearMode) => set({ composerClearMode }),
      theme: 'system',
      setTheme: (theme) => set({ theme }),
      inputImages: [],
      addInputImage: (img) =>
        set((s) => {
          if (s.inputImages.find((i) => i.id === img.id)) return s
          return { inputImages: [...s.inputImages, img] }
        }),
      removeInputImage: (idx) =>
        set((s) => {
          const removed = s.inputImages[idx]
          const shouldClearMask = removed?.id === s.maskDraft?.targetImageId
          return {
            inputImages: s.inputImages.filter((_, i) => i !== idx),
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      clearInputImages: () =>
        set((s) => {
          for (const img of s.inputImages) imageCache.delete(img.id)
          return { inputImages: [], maskDraft: null, maskEditorImageId: null }
        }),
      setInputImages: (imgs) =>
        set((s) => {
          const shouldClearMask =
            Boolean(s.maskDraft) && !imgs.some((img) => img.id === s.maskDraft?.targetImageId)
          return {
            inputImages: imgs,
            ...(shouldClearMask ? { maskDraft: null, maskEditorImageId: null } : {}),
          }
        }),
      maskDraft: null,
      setMaskDraft: (maskDraft) => set({ maskDraft }),
      clearMaskDraft: () => set({ maskDraft: null }),
      maskEditorImageId: null,
      setMaskEditorImageId: (maskEditorImageId) => set({ maskEditorImageId }),

      // Params
      params: { ...DEFAULT_PARAMS },
      setParams: (p) => set((s) => ({ params: { ...s.params, ...p } })),

      // Templates
      currentView: 'tasks',
      setCurrentView: (currentView) => set({ currentView }),
      templates: [],
      setTemplates: (templates) => set({ templates }),
      templateFilters: {
        query: '',
        category: '__all__',
        tag: '__all__',
        favoriteOnly: false,
        scope: 'all',
        sort: 'updated',
        collection: '__all__',
      },
      setTemplateFilters: (filters) =>
        set((s) => ({ templateFilters: { ...s.templateFilters, ...filters } })),
      selectedTemplateId: null,
      setSelectedTemplateId: (selectedTemplateId) => set({ selectedTemplateId }),
      selectedTemplateIds: [],
      setSelectedTemplateIds: (selectedTemplateIds) => set({ selectedTemplateIds }),
      templateEditor: null,
      setTemplateEditor: (templateEditor) => set({ templateEditor }),
      templateVariableTemplateId: null,
      setTemplateVariableTemplateId: (templateVariableTemplateId) => set({ templateVariableTemplateId }),
      activeTemplateId: null,
      setActiveTemplateId: (activeTemplateId) => set({ activeTemplateId }),

      // Tasks
      tasks: [],
      setTasks: (tasks) => set({ tasks }),

      // Search & Filter
      searchQuery: '',
      setSearchQuery: (searchQuery) => set({ searchQuery }),
      filterStatus: 'all',
      setFilterStatus: (filterStatus) => set({ filterStatus }),
      filterFavorite: false,
      setFilterFavorite: (filterFavorite) => set({ filterFavorite }),

      // Selection
      selectedTaskIds: [],
      setSelectedTaskIds: (updater) => set((s) => ({
        selectedTaskIds: typeof updater === 'function' ? updater(s.selectedTaskIds) : updater
      })),
      toggleTaskSelection: (id, force) => set((s) => {
        const isSelected = s.selectedTaskIds.includes(id)
        const shouldSelect = force !== undefined ? force : !isSelected
        if (shouldSelect === isSelected) return s
        return {
          selectedTaskIds: shouldSelect
            ? [...s.selectedTaskIds, id]
            : s.selectedTaskIds.filter((x) => x !== id)
        }
      }),
      clearSelection: () => set({ selectedTaskIds: [] }),

      // UI
      detailTaskId: null,
      setDetailTaskId: (detailTaskId) => set({ detailTaskId }),
      lightboxImageId: null,
      lightboxImageList: [],
      setLightboxImageId: (lightboxImageId, list) =>
        set({ lightboxImageId, lightboxImageList: list ?? (lightboxImageId ? [lightboxImageId] : []) }),
      showProjectManager: false,
      setShowProjectManager: (showProjectManager) => set({ showProjectManager }),
      showSettings: false,
      setShowSettings: (showSettings) => set({ showSettings }),
      showUserSettings: false,
      setShowUserSettings: (showUserSettings) => set({ showUserSettings }),

      // Toast
      toast: null,
      showToast: (message, type = 'info') => {
        set({ toast: { message, type } })
        setTimeout(() => {
          set((s) => (s.toast?.message === message ? { toast: null } : s))
        }, 3000)
      },

      // Confirm
      confirmDialog: null,
      setConfirmDialog: (confirmDialog) => set({ confirmDialog }),
    }),
    {
      name: 'gpt-image-playground',
      partialize: (state) => ({
        settings: state.settings,
        params: state.params,
        composerClearMode: state.composerClearMode,
        theme: state.theme,
        dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
      }),
    },
  ),
)

// ===== Actions =====

let uid = 0
export function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

export function getTemplateCoverImageIds(templates = useStore.getState().templates): string[] {
  return templates
    .map((template) => template.coverImageId)
    .filter((id): id is string => Boolean(id))
}

function pickEnabledModel(channel: ApiChannel | undefined, preferredModelId?: string | null) {
  if (!channel) return null
  const enabledModels = channel.models.filter((model) => model.enabled)
  if (!enabledModels.length) return null
  return enabledModels.find((model) => model.id === preferredModelId) ?? enabledModels[0]
}

export function syncChannelSelection(channels = useStore.getState().channels) {
  const state = useStore.getState()
  const currentChannel = channels.find((channel) => channel.id === state.settings.channelId)
  const fallbackChannel =
    (currentChannel && pickEnabledModel(currentChannel, state.settings.model) ? currentChannel : null) ??
    channels.find((channel) => pickEnabledModel(channel))

  if (!fallbackChannel) {
    state.setSettings({
      channelId: '',
      model: '',
      apiMode: DEFAULT_SETTINGS.apiMode,
      codexCli: false,
    })
    return
  }

  const selectedModel = pickEnabledModel(fallbackChannel, state.settings.model)
  if (!selectedModel) return

  state.setSettings({
    channelId: fallbackChannel.id,
    model: selectedModel.id,
    apiMode: selectedModel.apiMode,
    codexCli: fallbackChannel.codexCli,
  })
}

export function selectChannelModel(channelId: string, modelId?: string | null) {
  const channels = useStore.getState().channels
  const channel = channels.find((item) => item.id === channelId)
  const selectedModel = pickEnabledModel(channel, modelId)
  if (!channel || !selectedModel) return
  useStore.getState().setSettings({
    channelId: channel.id,
    model: selectedModel.id,
    apiMode: selectedModel.apiMode,
    codexCli: channel.codexCli,
  })
}

export function isServerStorageReady(): boolean {
  return Boolean(useStore.getState().backendUser)
}

export function assertServerStorageReady() {
  if (!useStore.getState().backendUser) {
    throw new Error('请先登录后端账户')
  }
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  return `${settings.channelId}\n${settings.model}\n${settings.codexCli ? '1' : '0'}`
}

export function isActiveTaskStatus(status: TaskStatus): boolean {
  return status === 'queued' || status === 'running'
}

export function showCodexCliPrompt(force = false, reason = '接口返回的提示词已被改写') {
  const state = useStore.getState()
  const settings = state.settings
  const promptKey = getCodexCliPromptKey(settings)
  if (!force && (settings.codexCli || state.dismissedCodexCliPrompts.includes(promptKey))) return

  state.setConfirmDialog({
    title: '检测到 Codex CLI API',
    message: `${reason}，当前 API 来源很可能是 Codex CLI。\n\n是否开启 Codex CLI 兼容模式？开启后会禁用在此处无效的质量参数，并在 Images API 多图生成时使用并发请求，解决该 API 数量参数无效的问题。同时，提示词文本开头会加入简短的不改写要求，避免模型重写提示词，偏离原意。`,
    confirmText: '开启',
    action: () => {
      const state = useStore.getState()
      state.dismissCodexCliPrompt(promptKey)
      state.setSettings({ codexCli: true })
    },
    cancelAction: () => useStore.getState().dismissCodexCliPrompt(promptKey),
  })
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  const updated = tasks.map((t) =>
    t.id === taskId ? { ...t, ...patch } : t,
  )
  setTasks(updated)
  const task = updated.find((t) => t.id === taskId)
  if (task) putTask(task)
}

// ===== Prompt template actions =====

export async function createTemplateFromDraft(draft: PromptTemplateDraft): Promise<PromptTemplate> {
  const normalized = normalizeTemplateDraft(draft)
  assertServerStorageReady()
  const template = await backendApi.createTemplate(useStore.getState().settings, normalized)
  useStore.getState().setTemplates([template, ...useStore.getState().templates])
  return template
}

export async function updateTemplateInStore(
  templateId: string,
  patch: Partial<Omit<PromptTemplate, 'id' | 'createdAt'>>,
  options: { bumpVersion?: boolean } = {},
): Promise<PromptTemplate | null> {
  const { templates, setTemplates } = useStore.getState()
  const existing = templates.find((template) => template.id === templateId)
  if (!existing) return null
  assertServerStorageReady()
  const normalizedPatch = patch.tags || patch.title || patch.description || patch.prompt || patch.model || patch.category || patch.projectId !== undefined
    ? normalizeTemplateDraft({ ...existing, ...patch, tags: patch.tags ?? existing.tags })
    : null
  const serverPatch = normalizedPatch
    ? { ...patch, ...normalizedPatch }
    : patch
  const updated = await backendApi.patchTemplate(useStore.getState().settings, templateId, serverPatch)
  setTemplates(templates.map((template) => (template.id === templateId ? updated : template)))
  return updated
}

export async function removeTemplate(templateId: string) {
  const { templates, setTemplates, templateSubmissions, setTemplateSubmissions, selectedTemplateId, activeTemplateId, showToast } = useStore.getState()
  assertServerStorageReady()
  setTemplates(templates.filter((template) => template.id !== templateId))
  setTemplateSubmissions(templateSubmissions.filter((template) => template.id !== templateId))
  await backendApi.deleteTemplate(useStore.getState().settings, templateId)
  if (selectedTemplateId === templateId) useStore.getState().setSelectedTemplateId(null)
  if (activeTemplateId === templateId) useStore.getState().setActiveTemplateId(null)
  showToast('模板已删除', 'success')
}

export async function removeMultipleTemplates(templateIds: string[]) {
  if (!templateIds.length) return
  const { templates, setTemplates, templateSubmissions, setTemplateSubmissions, selectedTemplateId, activeTemplateId, showToast } = useStore.getState()
  assertServerStorageReady()
  const toDelete = new Set(templateIds)
  setTemplates(templates.filter((t) => !toDelete.has(t.id)))
  setTemplateSubmissions(templateSubmissions.filter((t) => !toDelete.has(t.id)))
  await backendApi.batchDeleteTemplates(useStore.getState().settings, templateIds)
  if (selectedTemplateId && toDelete.has(selectedTemplateId)) useStore.getState().setSelectedTemplateId(null)
  if (activeTemplateId && toDelete.has(activeTemplateId)) useStore.getState().setActiveTemplateId(null)
  showToast(`已删除 ${templateIds.length} 个模板`, 'success')
}

export async function duplicateTemplate(templateId: string): Promise<PromptTemplate | null> {
  const state = useStore.getState()
  const template = state.templates.find((item) => item.id === templateId)
  if (!template) return null
  assertServerStorageReady()
  const targetProjectId = normalizeSelectedProjectId(state.currentProjectId) ?? normalizeSelectedProjectId(template.projectId)
  const copy = await createTemplateFromDraft({
    title: `${template.title} 副本`,
    description: template.description,
    prompt: template.prompt,
    negativePrompt: template.negativePrompt,
    tags: template.tags,
    category: template.category,
    params: template.params,
    channelId: template.channelId,
    apiMode: template.apiMode,
    model: template.model,
    coverImageId: template.coverImageId,
    externalCoverUrl: template.externalCoverUrl,
    exampleImages: template.exampleImages,
    recommendedChannelId: template.recommendedChannelId,
    recommendedApiMode: template.recommendedApiMode,
    recommendedModel: template.recommendedModel,
    linkedTaskIds: [],
    isFavorite: false,
    sourceName: template.sourceName,
    sourceUrl: template.sourceUrl,
    sourceAuthor: template.sourceAuthor,
    licenseName: template.licenseName,
    projectId: targetProjectId,
    formFields: template.formFields,
    collections: template.collections,
    isFeatured: false,
  })
  useStore.getState().showToast(targetProjectId ? '模板已复制到当前项目' : '模板已复制', 'success')
  return copy
}

export async function toggleTemplateFavorite(templateId: string) {
  const template = useStore.getState().templates.find((item) => item.id === templateId)
  if (!template) return
  await updateTemplateInStore(templateId, { isFavorite: !template.isFavorite })
}

export function applyTemplate(template: PromptTemplate) {
  const variables = template.formFields.length
    ? formFieldsToVariableDefinitions(template.formFields).map((item) => item.name)
    : extractTemplateVariables(template.prompt, template.negativePrompt)
  if (variables.length) {
    useStore.getState().setTemplateVariableTemplateId(template.id)
    return
  }
  applyTemplateWithVariables(template, {})
}

export function applyTemplateWithVariables(template: PromptTemplate, values: Record<string, string>) {
  const { settings, templates, currentProjectId, setTemplates, setPrompt, setParams, setSettings, setActiveTemplateId, setCurrentView, setSelectedTemplateId, setTemplateVariableTemplateId, setCurrentProjectId, requestComposerReveal, showToast } =
    useStore.getState()
  const channelId = template.recommendedChannelId || template.channelId || ''
  const apiMode = template.recommendedApiMode || template.apiMode
  const model = template.recommendedModel || template.model
  const nextProjectId = isApprovedPublicTemplate(template)
    ? normalizeSelectedProjectId(currentProjectId)
    : normalizeSelectedProjectId(template.projectId) ?? normalizeSelectedProjectId(currentProjectId)
  setPrompt(composeTemplatePrompt(template, values))
  setParams(template.params)
  setSettings({
    channelId,
    apiMode,
    model,
  })
  if (channelId) {
    selectChannelModel(channelId, model)
  }
  setActiveTemplateId(template.id)
  setCurrentView('tasks')
  setSelectedTemplateId(null)
  setTemplateVariableTemplateId(null)
  setCurrentProjectId(nextProjectId)
  requestComposerReveal()
  void backendApi.markTemplateUsed(settings, template.id)
    .then((updated) => setTemplates(templates.map((item) => (item.id === template.id ? updated : item))))
    .catch(() => undefined)
  showToast('已套用模板到输入区', 'success')
}

export async function linkTaskToTemplate(templateId: string, taskId: string) {
  const template = useStore.getState().templates.find((item) => item.id === templateId)
  if (!template) return
  if (template.linkedTaskIds.includes(taskId)) return
  await updateTemplateInStore(templateId, { linkedTaskIds: [taskId, ...template.linkedTaskIds] })
}

export async function setTemplateCover(templateId: string, imageId: string) {
  assertServerStorageReady()
  const updated = await backendApi.setTemplateCover(useStore.getState().settings, templateId, imageId)
    .then((template) => {
      useStore.getState().setTemplates(
        useStore.getState().templates.map((item) => (item.id === templateId ? template : item)),
      )
      return template
    })
  if (updated) {
    useStore.getState().showToast('已设为模板封面', 'success')
  }
}

export async function createTemplateFromTask(task: TaskRecord, draft: PromptTemplateDraft): Promise<PromptTemplate> {
  const template = await createTemplateFromDraft({
    ...draft,
    linkedTaskIds: [...new Set([task.id, ...(draft.linkedTaskIds ?? [])])],
  })
  updateTaskInStore(task.id, {
    templateId: template.id,
    templateVersionId: String(template.version),
  })
  return template
}

/** 复用配置 */
export async function reuseConfig(task: TaskRecord) {
  const { setPrompt, setParams, setInputImages, setMaskDraft, clearMaskDraft, setActiveTemplateId, showToast } = useStore.getState()
  setPrompt(task.prompt)
  setParams(task.params)
  setActiveTemplateId(task.templateId ?? null)

  // 恢复输入图片
  const imgs: InputImage[] = []
  for (const imgId of task.inputImageIds) {
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      imgs.push({ id: imgId, dataUrl })
    }
  }
  setInputImages(imgs)
  const maskTargetImageId = task.maskTargetImageId ?? (task.maskImageId ? task.inputImageIds[0] : null)
  if (maskTargetImageId && task.maskImageId && imgs.some((img) => img.id === maskTargetImageId)) {
    const maskDataUrl = await ensureImageCached(task.maskImageId)
    if (maskDataUrl) {
      setMaskDraft({
        targetImageId: maskTargetImageId,
        maskDataUrl,
        updatedAt: Date.now(),
      })
    } else {
      clearMaskDraft()
    }
  } else {
    clearMaskDraft()
  }
  showToast('已复用配置到输入框', 'success')
}

/** 编辑输出：将输出图加入输入 */
export async function editOutputs(task: TaskRecord) {
  const { inputImages, addInputImage, clearMaskDraft, setPendingParentTaskId, setCurrentProjectId, showToast } = useStore.getState()
  if (!task.outputImages?.length) return

  clearMaskDraft()
  let added = 0
  for (const imgId of task.outputImages) {
    if (inputImages.find((i) => i.id === imgId)) continue
    const dataUrl = await ensureImageCached(imgId)
    if (dataUrl) {
      addInputImage({ id: imgId, dataUrl })
      added++
    }
  }
  setPendingParentTaskId(task.id)
  setCurrentProjectId(task.projectId ?? null)
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, showToast, selectedTaskIds } = useStore.getState()

  if (!taskIds.length) return

  const toDelete = new Set(taskIds)
  const remaining = tasks.filter(t => !toDelete.has(t.id))

  const deletedImageIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      for (const id of t.inputImageIds || []) deletedImageIds.add(id)
      if (t.maskImageId) deletedImageIds.add(t.maskImageId)
      for (const id of t.outputImages || []) deletedImageIds.add(id)
    }
  }

  setTasks(remaining)
  if (isServerStorageReady()) {
    await backendApi.batchDeleteGenerations(useStore.getState().settings, taskIds).catch(() => undefined)
  } else {
    for (const id of taskIds) {
      await dbDeleteTask(id)
    }
  }

  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)
  for (const imgId of getTemplateCoverImageIds()) stillUsed.add(imgId)

  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
    }
  }

  const newSelection = selectedTaskIds.filter(id => !toDelete.has(id))
  if (newSelection.length !== selectedTaskIds.length) {
    useStore.getState().setSelectedTaskIds(newSelection)
  }

  showToast(`已删除 ${taskIds.length} 条记录`, 'success')
}

/** 删除单条任务 */
export async function removeTask(task: TaskRecord) {
  const { tasks, setTasks, inputImages, showToast } = useStore.getState()

  // 收集此任务关联的图片
  const taskImageIds = new Set([
    ...(task.inputImageIds || []),
    ...(task.maskImageId ? [task.maskImageId] : []),
    ...(task.outputImages || []),
  ])

  // 从列表移除
  const remaining = tasks.filter((t) => t.id !== task.id)
  setTasks(remaining)
  if (isServerStorageReady()) {
    await backendApi.deleteGeneration(useStore.getState().settings, task.id).catch(() => undefined)
  } else {
    await dbDeleteTask(task.id)
  }

  // 找出其他任务仍引用的图片
  const stillUsed = new Set<string>()
  for (const t of remaining) {
    for (const id of t.inputImageIds || []) stillUsed.add(id)
    if (t.maskImageId) stillUsed.add(t.maskImageId)
    for (const id of t.outputImages || []) stillUsed.add(id)
  }
  for (const img of inputImages) stillUsed.add(img.id)
  for (const imgId of getTemplateCoverImageIds()) stillUsed.add(imgId)

  // 删除孤立图片
  for (const imgId of taskImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
    }
  }

  showToast('记录已删除', 'success')
}

/** 清空当前浏览器本地缓存（含本地配置重置，不删除后端数据库） */
export async function clearAllData() {
  await dbClearTasks()
  await dbClearTemplates()
  await clearImages()
  imageCache.clear()
  const { setTasks, setTemplates, clearInputImages, clearMaskDraft, setSettings, setParams, showToast } = useStore.getState()
  setTasks([])
  setTemplates([])
  clearInputImages()
  useStore.setState({ dismissedCodexCliPrompts: [] })
  useStore.getState().setActiveTemplateId(null)
  useStore.getState().setCurrentProjectId(null)
  useStore.getState().setPendingParentTaskId(null)
  useStore.getState().setGenerationPreflight(null)
  clearMaskDraft()
  setSettings({ ...DEFAULT_SETTINGS })
  setParams({ ...DEFAULT_PARAMS })
  showToast('本地缓存已清空，后端数据不会被删除', 'success')
}

/** 导出数据为 ZIP */
export async function exportData() {
  try {
    const { settings, backendUser } = useStore.getState()
    if (!canManageSystem(backendUser)) {
      throw new Error('只有管理员可以导出服务端备份')
    }
    const blob = await backendApi.exportSystemBackup(settings)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gpt-image-playground-backup-${Date.now()}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('服务端备份已导出', 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导出失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
  }
}

/** 导入 ZIP 数据 */
export async function importData(file: File) {
  try {
    const { settings, backendUser } = useStore.getState()
    if (!canManageSystem(backendUser)) {
      throw new Error('只有管理员可以导入服务端备份')
    }
    const result = await backendApi.importSystemBackup(settings, file)
    imageCache.clear()
    await clearImages()
    await backendApi.getMe(settings).then((user) => useStore.getState().setBackendUser(user))
    const { syncServerData } = await import('./storeBackend')
    await syncServerData()
    useStore.getState().showToast(
      result.restorePointName
        ? `服务端备份已导入，已自动创建恢复点 ${result.restorePointName}`
        : '服务端备份已导入并重新同步',
      'success',
    )
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导入失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
  }
}

export async function exportTemplatePack(templates?: PromptTemplate[]) {
  try {
    const source = templates ?? useStore.getState().templates
    const exportedAt = new Date().toISOString()
    const payload = {
      version: 1,
      exportedAt,
      templates: source.map((template) => ({
        title: template.title,
        description: template.description,
        prompt: template.prompt,
        negativePrompt: template.negativePrompt,
        tags: template.tags,
        category: template.category,
        params: template.params,
        channelId: template.channelId,
        apiMode: template.apiMode,
        model: template.model,
        externalCoverUrl: template.externalCoverUrl,
        exampleImages: template.exampleImages,
        recommendedChannelId: template.recommendedChannelId,
        recommendedApiMode: template.recommendedApiMode,
        recommendedModel: template.recommendedModel,
        sourceName: template.sourceName,
        sourceUrl: template.sourceUrl,
        sourceAuthor: template.sourceAuthor,
        licenseName: template.licenseName,
        collections: template.collections,
        formFields: template.formFields,
        isFeatured: template.isFeatured,
      })),
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `template-pack-${Date.now()}.json`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast(`已导出 ${payload.templates.length} 个模板`, 'success')
  } catch (err) {
    useStore.getState().showToast(`模板包导出失败：${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

export async function optimizeCurrentPrompt() {
  const { prompt, settings, showToast, setPrompt } = useStore.getState()
  if (!prompt.trim()) {
    showToast('请输入提示词后再优化', 'error')
    return
  }
  try {
    const result = await backendApi.optimizePrompt(settings, {
      prompt,
      channelId: settings.channelId || null,
      model: settings.model || null,
    })
    setPrompt(result.prompt)
    showToast(result.method === 'responses' ? '已使用上游模型优化提示词' : '已完成本地结构化优化', 'success')
  } catch (err) {
    showToast(`提示词优化失败：${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

/** 添加图片到输入（文件上传）—— 仅放入内存缓存，不写 IndexedDB */
export async function addImageFromFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) return
  const dataUrl = await fileToDataUrl(file)
  const id = await hashDataUrl(dataUrl)
  imageCache.set(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

/** 添加图片到输入（右键菜单）—— 支持 data/blob/http URL */
export async function addImageFromUrl(src: string): Promise<void> {
  const res = await fetch(src)
  const blob = await res.blob()
  if (!blob.type.startsWith('image/')) throw new Error('不是有效的图片')
  const dataUrl = await blobToDataUrl(blob)
  const id = await hashDataUrl(dataUrl)
  imageCache.set(id, dataUrl)
  useStore.getState().addInputImage({ id, dataUrl })
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}
