import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type {
  AppSettings,
  TaskParams,
  InputImage,
  MaskDraft,
  TaskRecord,
  ExportData,
  PromptTemplate,
  PromptTemplateDraft,
  TemplateFilters,
  BackendUser,
} from './types'
import { DEFAULT_SETTINGS, DEFAULT_PARAMS } from './types'
import {
  getAllTasks,
  getAllTemplates,
  putTask,
  putTemplate,
  deleteTask as dbDeleteTask,
  deleteTemplate as dbDeleteTemplate,
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
import { callImageApi } from './lib/api'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { normalizeImageSize } from './lib/size'
import { composeTemplatePrompt, duplicateTemplateRecord, extractTemplateVariables, normalizeTemplateDraft } from './lib/templateUtils'
import * as backendApi from './lib/backendApi'
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'

// ===== Image cache =====
// 内存缓存，id → dataUrl，避免每次从 IndexedDB 读取

const imageCache = new Map<string, string>()

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
  dismissedCodexCliPrompts: string[]
  dismissCodexCliPrompt: (key: string) => void

  // 输入
  prompt: string
  setPrompt: (p: string) => void
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
  filterStatus: 'all' | 'running' | 'done' | 'error'
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
  showSettings: boolean
  setShowSettings: (v: boolean) => void

  // Toast
  toast: { message: string; type: 'info' | 'success' | 'error' } | null
  showToast: (message: string, type?: 'info' | 'success' | 'error') => void

  // Confirm dialog
  confirmDialog: {
    title: string
    message: string
    confirmText?: string
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
        settings: {
          ...st.settings,
          ...s,
          apiMode:
            s.apiMode === 'images' || s.apiMode === 'responses'
              ? s.apiMode
              : st.settings.apiMode ?? DEFAULT_SETTINGS.apiMode,
          codexCli: s.codexCli ?? st.settings.codexCli ?? DEFAULT_SETTINGS.codexCli,
          backendUrl: s.backendUrl ?? st.settings.backendUrl ?? DEFAULT_SETTINGS.backendUrl,
          storageMode:
            s.storageMode === 'server' || s.storageMode === 'local'
              ? s.storageMode
              : st.settings.storageMode ?? DEFAULT_SETTINGS.storageMode,
          generationMode:
            s.generationMode === 'server' || s.generationMode === 'direct'
              ? s.generationMode
              : st.settings.generationMode ?? DEFAULT_SETTINGS.generationMode,
        },
      })),
      backendUser: null,
      setBackendUser: (backendUser) => set({ backendUser }),
      backendReady: false,
      setBackendReady: (backendReady) => set({ backendReady }),
      dismissedCodexCliPrompts: [],
      dismissCodexCliPrompt: (key) => set((st) => ({
        dismissedCodexCliPrompts: st.dismissedCodexCliPrompts.includes(key)
          ? st.dismissedCodexCliPrompts
          : [...st.dismissedCodexCliPrompts, key],
      })),

      // Input
      prompt: '',
      setPrompt: (prompt) => set({ prompt }),
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
      },
      setTemplateFilters: (filters) =>
        set((s) => ({ templateFilters: { ...s.templateFilters, ...filters } })),
      selectedTemplateId: null,
      setSelectedTemplateId: (selectedTemplateId) => set({ selectedTemplateId }),
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
      showSettings: false,
      setShowSettings: (showSettings) => set({ showSettings }),

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
        dismissedCodexCliPrompts: state.dismissedCodexCliPrompts,
      }),
    },
  ),
)

// ===== Actions =====

let uid = 0
function genId(): string {
  return Date.now().toString(36) + (++uid).toString(36) + Math.random().toString(36).slice(2, 6)
}

function getTemplateCoverImageIds(templates = useStore.getState().templates): string[] {
  return templates
    .map((template) => template.coverImageId)
    .filter((id): id is string => Boolean(id))
}

function isServerStorageReady(): boolean {
  const state = useStore.getState()
  return state.settings.storageMode === 'server' && Boolean(state.backendUser)
}

function assertServerStorageReady() {
  const state = useStore.getState()
  if (state.settings.storageMode === 'server' && !state.backendUser) {
    throw new Error('请先登录后端账户')
  }
}

export function getCodexCliPromptKey(settings: AppSettings): string {
  return `${settings.baseUrl}\n${settings.apiKey}`
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

/** 初始化：从 IndexedDB 加载任务和图片缓存，清理孤立图片 */
export async function initStore() {
  const [tasks, templates] = await Promise.all([getAllTasks(), getAllTemplates()])
  useStore.getState().setTasks(tasks)
  useStore.getState().setTemplates(templates)

  // 收集所有任务引用的图片 id
  const referencedIds = new Set<string>()
  for (const t of tasks) {
    for (const id of t.inputImageIds || []) referencedIds.add(id)
    if (t.maskImageId) referencedIds.add(t.maskImageId)
    for (const id of t.outputImages || []) referencedIds.add(id)
  }
  for (const id of getTemplateCoverImageIds(templates)) {
    referencedIds.add(id)
  }

  // 预加载所有图片到缓存，同时清理孤立图片
  const images = await getAllImages()
  for (const img of images) {
    if (referencedIds.has(img.id)) {
      imageCache.set(img.id, img.dataUrl)
    } else {
      await deleteImage(img.id)
    }
  }

  await loadBackendSession({ silent: true })
}

/** 提交新任务 */
export async function submitTask(options: { allowFullMask?: boolean } = {}) {
  const { settings, prompt, inputImages, maskDraft, params, activeTemplateId, templates, showToast, setConfirmDialog } =
    useStore.getState()

  if (settings.generationMode === 'direct' && !settings.apiKey) {
    showToast('请先在设置中配置 API Key', 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (settings.generationMode === 'server' && !useStore.getState().backendUser) {
    showToast('请先登录后端账户', 'error')
    useStore.getState().setShowSettings(true)
    return
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return
  }

  let orderedInputImages = inputImages
  let maskImageId: string | null = null
  let maskTargetImageId: string | null = null

  if (maskDraft) {
    try {
      orderedInputImages = orderInputImagesForMask(inputImages, maskDraft.targetImageId)
      const coverage = await validateMaskMatchesImage(maskDraft.maskDataUrl, orderedInputImages[0].dataUrl)
      if (coverage === 'full' && !options.allowFullMask) {
        setConfirmDialog({
          title: '确认编辑整张图片？',
          message: '当前遮罩覆盖了整张图片，提交后可能会重绘全部内容。是否继续？',
          confirmText: '继续提交',
          tone: 'warning',
          action: () => {
            void submitTask({ allowFullMask: true })
          },
        })
        return
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      imageCache.set(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
  }

  // 持久化输入图片到 IndexedDB（此前只在内存缓存中）
  for (const img of orderedInputImages) {
    await storeImage(img.dataUrl)
  }

  const normalizedParams = {
    ...params,
    size: normalizeImageSize(params.size) || DEFAULT_PARAMS.size,
    quality: settings.codexCli ? DEFAULT_PARAMS.quality : params.quality,
  }
  if (normalizedParams.size !== params.size || normalizedParams.quality !== params.quality) {
    useStore.getState().setParams({ size: normalizedParams.size, quality: normalizedParams.quality })
  }

  const taskId = genId()
  const sourceTemplate = activeTemplateId
    ? templates.find((template) => template.id === activeTemplateId) ?? null
    : null
  const task: TaskRecord = {
    id: taskId,
    ...(sourceTemplate ? { templateId: sourceTemplate.id, templateVersionId: String(sourceTemplate.version) } : {}),
    prompt: prompt.trim(),
    params: normalizedParams,
    inputImageIds: orderedInputImages.map((i) => i.id),
    maskTargetImageId,
    maskImageId,
    outputImages: [],
    status: 'running',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
  }

  const latestTasks = useStore.getState().tasks
  useStore.getState().setTasks([task, ...latestTasks])
  await putTask(task)
  if (sourceTemplate) {
    await linkTaskToTemplate(sourceTemplate.id, taskId)
  }

  // 异步调用 API
  if (settings.generationMode === 'server') {
    executeServerTask(taskId)
  } else {
    executeTask(taskId)
  }
}

async function executeServerTask(taskId: string) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return

  try {
    const inputDataUrls: string[] = []
    for (const imgId of task.inputImageIds) {
      const dataUrl = await ensureImageCached(imgId)
      if (!dataUrl) throw new Error('输入图片已不存在')
      inputDataUrls.push(dataUrl)
    }
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    await backendApi.runGeneration(settings, {
      taskId,
      templateId: task.templateId,
      templateVersionId: task.templateVersionId,
      settings,
      prompt: task.prompt,
      params: task.params,
      inputImageDataUrls: inputDataUrls,
      maskDataUrl,
    })

    const deadline = Date.now() + Math.max(30_000, settings.timeout * 1000 + 15_000)
    let serverTask = await backendApi.getGeneration(settings, taskId)
    while (serverTask.status === 'running' && Date.now() < deadline) {
      await new Promise((resolve) => window.setTimeout(resolve, 1200))
      serverTask = await backendApi.getGeneration(settings, taskId)
    }

    if (serverTask.status === 'running') {
      throw new Error('后端生成仍在进行中，请稍后同步任务状态')
    }
    if (serverTask.status === 'error') {
      throw new Error(serverTask.error || '后端生成失败')
    }

    for (const imgId of serverTask.outputImages || []) {
      if (imageCache.has(imgId)) continue
      const dataUrl = await backendApi.getAssetDataUrl(settings, imgId)
      await putImage({ id: imgId, dataUrl, createdAt: Date.now(), source: 'generated' })
      imageCache.set(imgId, dataUrl)
    }

    const outputIds = serverTask.outputImages || []
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      actualParams: serverTask.actualParams as Partial<TaskParams> | undefined,
      actualParamsByImage: serverTask.actualParamsByImage as Record<string, Partial<TaskParams>> | undefined,
      revisedPromptByImage: serverTask.revisedPromptByImage,
      status: 'done',
      finishedAt: serverTask.finishedAt ?? Date.now(),
      elapsed: serverTask.elapsed ?? Date.now() - task.createdAt,
    })
    useStore.getState().showToast(`后端生成完成，共 ${outputIds.length} 张图片`, 'success')
  } catch (err) {
    updateTaskInStore(taskId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    useStore.getState().setDetailTaskId(taskId)
  }

  for (const imgId of task.inputImageIds) {
    imageCache.delete(imgId)
  }
}

async function executeTask(taskId: string) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((t) => t.id === taskId)
  if (!task) return

  try {
    // 获取输入图片 data URLs
    const inputDataUrls: string[] = []
    for (const imgId of task.inputImageIds) {
      const dataUrl = await ensureImageCached(imgId)
      if (!dataUrl) throw new Error('输入图片已不存在')
      inputDataUrls.push(dataUrl)
    }
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    const result = await callImageApi({
      settings,
      prompt: task.prompt,
      params: task.params,
      inputImageDataUrls: inputDataUrls,
      maskDataUrl,
    })

    // 存储输出图片
    const outputIds: string[] = []
    for (const dataUrl of result.images) {
      const imgId = await storeImage(dataUrl, 'generated')
      imageCache.set(imgId, dataUrl)
      outputIds.push(imgId)
    }
    const actualParamsByImage = result.actualParamsList?.reduce<Record<string, Partial<TaskParams>>>((acc, params, index) => {
      const imgId = outputIds[index]
      if (imgId && params && Object.keys(params).length > 0) acc[imgId] = params
      return acc
    }, {})
    const revisedPromptByImage = result.revisedPrompts?.reduce<Record<string, string>>((acc, revisedPrompt, index) => {
      const imgId = outputIds[index]
      if (imgId && revisedPrompt && revisedPrompt.trim()) acc[imgId] = revisedPrompt
      return acc
    }, {})
    const promptWasRevised = result.revisedPrompts?.some(
      (revisedPrompt) => revisedPrompt?.trim() && revisedPrompt.trim() !== task.prompt.trim(),
    )
    const hasRevisedPromptValue = result.revisedPrompts?.some((revisedPrompt) => revisedPrompt?.trim())
    if (!settings.codexCli) {
      if (promptWasRevised) {
        showCodexCliPrompt()
      } else if (!hasRevisedPromptValue) {
        showCodexCliPrompt(false, '接口没有返回官方 API 会返回的部分信息')
      }
    }

    // 更新任务
    updateTaskInStore(taskId, {
      outputImages: outputIds,
      actualParams: { ...result.actualParams, n: outputIds.length },
      actualParamsByImage: actualParamsByImage && Object.keys(actualParamsByImage).length > 0 ? actualParamsByImage : undefined,
      revisedPromptByImage: revisedPromptByImage && Object.keys(revisedPromptByImage).length > 0 ? revisedPromptByImage : undefined,
      status: 'done',
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })

    useStore.getState().showToast(`生成完成，共 ${outputIds.length} 张图片`, 'success')
    const currentMask = useStore.getState().maskDraft
    if (
      maskDataUrl &&
      currentMask &&
      currentMask.targetImageId === task.maskTargetImageId &&
      currentMask.maskDataUrl === maskDataUrl
    ) {
      useStore.getState().clearMaskDraft()
    }
  } catch (err) {
    updateTaskInStore(taskId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    useStore.getState().setDetailTaskId(taskId)
  }

  // 释放输入图片的内存缓存（已持久化到 IndexedDB，后续按需从 DB 加载）
  for (const imgId of task.inputImageIds) {
    imageCache.delete(imgId)
  }
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

export async function loadBackendSession(options: { silent?: boolean } = {}) {
  const state = useStore.getState()
  try {
    const user = await backendApi.getMe(state.settings)
    useStore.getState().setBackendUser(user)
    if (state.settings.storageMode === 'server') {
      await syncServerData()
    }
  } catch (err) {
    useStore.getState().setBackendUser(null)
    if (state.settings.storageMode === 'server') {
      useStore.getState().setTemplates([])
      useStore.getState().setTasks([])
    }
    if (!options.silent) {
      useStore.getState().showToast(`后端未登录：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  } finally {
    useStore.getState().setBackendReady(true)
  }
}

export async function loginBackend(username: string, password: string) {
  const { settings, showToast } = useStore.getState()
  const user = await backendApi.login(settings, username, password)
  useStore.getState().setBackendUser(user)
  await syncServerData()
  showToast('登录成功', 'success')
}

export async function registerBackend(username: string, password: string) {
  const { settings, showToast } = useStore.getState()
  const user = await backendApi.register(settings, username, password)
  useStore.getState().setBackendUser(user)
  await syncServerData()
  showToast('注册并登录成功', 'success')
}

export async function logoutBackend() {
  const { settings, showToast } = useStore.getState()
  await backendApi.logout(settings)
  useStore.getState().setBackendUser(null)
  if (settings.storageMode === 'server') {
    useStore.getState().setTemplates([])
    useStore.getState().setTasks([])
  }
  showToast('已退出登录', 'success')
}

export async function syncServerData() {
  const { settings, backendUser, setTemplates, setTasks, showToast } = useStore.getState()
  if (!backendUser) return

  try {
    const [templates, tasks] = await Promise.all([
      backendApi.listTemplates(settings),
      backendApi.listGenerations(settings),
    ])

    setTemplates(templates)
    setTasks(tasks)

    const imageIds = new Set<string>()
    for (const template of templates) {
      if (template.coverImageId) imageIds.add(template.coverImageId)
    }
    for (const task of tasks) {
      for (const id of task.inputImageIds || []) imageIds.add(id)
      if (task.maskImageId) imageIds.add(task.maskImageId)
      for (const id of task.outputImages || []) imageIds.add(id)
    }

    for (const imageId of imageIds) {
      if (imageCache.has(imageId)) continue
      try {
        const dataUrl = await backendApi.getAssetDataUrl(settings, imageId)
        imageCache.set(imageId, dataUrl)
        await putImage({ id: imageId, dataUrl, createdAt: Date.now(), source: 'generated' })
      } catch {
        /* Missing remote assets should not block the rest of the library. */
      }
    }
  } catch (err) {
    showToast(`同步后端数据失败：${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

// ===== Prompt template actions =====

export async function createTemplateFromDraft(draft: PromptTemplateDraft): Promise<PromptTemplate> {
  const normalized = normalizeTemplateDraft(draft)
  assertServerStorageReady()
  if (isServerStorageReady()) {
    const template = await backendApi.createTemplate(useStore.getState().settings, normalized)
    useStore.getState().setTemplates([template, ...useStore.getState().templates])
    return template
  }

  const now = Date.now()
  const template: PromptTemplate = {
    ...normalized,
    id: genId(),
    userId: null,
    version: 1,
    linkedTaskIds: normalized.linkedTaskIds ?? [],
    isFavorite: normalized.isFavorite ?? false,
    createdAt: now,
    updatedAt: now,
  }

  await putTemplate(template)
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

  if (isServerStorageReady()) {
    const normalizedPatch = patch.tags || patch.title || patch.description || patch.prompt || patch.model || patch.category
      ? normalizeTemplateDraft({ ...existing, ...patch, tags: patch.tags ?? existing.tags })
      : null
    const serverPatch = normalizedPatch
      ? { ...patch, ...normalizedPatch }
      : patch
    const updated = await backendApi.patchTemplate(useStore.getState().settings, templateId, serverPatch)
    setTemplates(templates.map((template) => (template.id === templateId ? updated : template)))
    return updated
  }

  const updated: PromptTemplate = {
    ...existing,
    ...patch,
    tags: patch.tags ? normalizeTemplateDraft({ ...existing, ...patch, tags: patch.tags }).tags : existing.tags,
    linkedTaskIds: patch.linkedTaskIds ? [...new Set(patch.linkedTaskIds)] : existing.linkedTaskIds,
    coverImageId: patch.coverImageId === undefined ? existing.coverImageId : patch.coverImageId || null,
    version: options.bumpVersion ? existing.version + 1 : patch.version ?? existing.version,
    updatedAt: Date.now(),
  }

  await putTemplate(updated)
  setTemplates(templates.map((template) => (template.id === templateId ? updated : template)))
  return updated
}

export async function removeTemplate(templateId: string) {
  const { templates, setTemplates, selectedTemplateId, activeTemplateId, showToast } = useStore.getState()
  assertServerStorageReady()
  setTemplates(templates.filter((template) => template.id !== templateId))
  if (isServerStorageReady()) {
    await backendApi.deleteTemplate(useStore.getState().settings, templateId)
  } else {
    await dbDeleteTemplate(templateId)
  }
  if (selectedTemplateId === templateId) useStore.getState().setSelectedTemplateId(null)
  if (activeTemplateId === templateId) useStore.getState().setActiveTemplateId(null)
  showToast('模板已删除', 'success')
}

export async function duplicateTemplate(templateId: string): Promise<PromptTemplate | null> {
  const template = useStore.getState().templates.find((item) => item.id === templateId)
  if (!template) return null
  assertServerStorageReady()

  if (isServerStorageReady()) {
    const copy = await backendApi.duplicateTemplate(useStore.getState().settings, templateId)
    useStore.getState().setTemplates([copy, ...useStore.getState().templates])
    useStore.getState().showToast('模板已复制', 'success')
    return copy
  }

  const copy = duplicateTemplateRecord(template, genId(), Date.now())
  await putTemplate(copy)
  useStore.getState().setTemplates([copy, ...useStore.getState().templates])
  useStore.getState().showToast('模板已复制', 'success')
  return copy
}

export async function toggleTemplateFavorite(templateId: string) {
  const template = useStore.getState().templates.find((item) => item.id === templateId)
  if (!template) return
  await updateTemplateInStore(templateId, { isFavorite: !template.isFavorite })
}

export function applyTemplate(template: PromptTemplate) {
  const variables = extractTemplateVariables(template.prompt, template.negativePrompt)
  if (variables.length) {
    useStore.getState().setTemplateVariableTemplateId(template.id)
    return
  }
  applyTemplateWithVariables(template, {})
}

export function applyTemplateWithVariables(template: PromptTemplate, values: Record<string, string>) {
  const { setPrompt, setParams, setSettings, setActiveTemplateId, setCurrentView, setSelectedTemplateId, setTemplateVariableTemplateId, showToast } =
    useStore.getState()
  setPrompt(composeTemplatePrompt(template, values))
  setParams(template.params)
  setSettings({ apiMode: template.apiMode, model: template.model })
  setActiveTemplateId(template.id)
  setCurrentView('tasks')
  setSelectedTemplateId(null)
  setTemplateVariableTemplateId(null)
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
  const updated = isServerStorageReady()
    ? await backendApi.setTemplateCover(useStore.getState().settings, templateId, imageId)
      .then((template) => {
        useStore.getState().setTemplates(
          useStore.getState().templates.map((item) => (item.id === templateId ? template : item)),
        )
        return template
      })
    : await updateTemplateInStore(templateId, { coverImageId: imageId })
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
  const { inputImages, addInputImage, clearMaskDraft, showToast } = useStore.getState()
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
  showToast(`已添加 ${added} 张输出图到输入`, 'success')
}

/** 删除多条任务 */
export async function removeMultipleTasks(taskIds: string[]) {
  const { tasks, setTasks, inputImages, showToast, clearSelection, selectedTaskIds } = useStore.getState()
  
  if (!taskIds.length) return

  const toDelete = new Set(taskIds)
  const remaining = tasks.filter(t => !toDelete.has(t.id))

  // 收集所有被删除任务的关联图片
  const deletedImageIds = new Set<string>()
  for (const t of tasks) {
    if (toDelete.has(t.id)) {
      for (const id of t.inputImageIds || []) deletedImageIds.add(id)
      if (t.maskImageId) deletedImageIds.add(t.maskImageId)
      for (const id of t.outputImages || []) deletedImageIds.add(id)
    }
  }

  setTasks(remaining)
  for (const id of taskIds) {
    if (isServerStorageReady()) {
      await backendApi.deleteGeneration(useStore.getState().settings, id).catch(() => undefined)
    } else {
      await dbDeleteTask(id)
    }
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
  for (const imgId of deletedImageIds) {
    if (!stillUsed.has(imgId)) {
      await deleteImage(imgId)
      imageCache.delete(imgId)
    }
  }

  // 如果删除的任务在选中列表中，则移除
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

/** 清空所有数据（含配置重置） */
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
  clearMaskDraft()
  setSettings({ ...DEFAULT_SETTINGS })
  setParams({ ...DEFAULT_PARAMS })
  showToast('所有数据已清空', 'success')
}

/** 从 dataUrl 解析出 MIME 扩展名和二进制数据 */
function dataUrlToBytes(dataUrl: string): { ext: string; bytes: Uint8Array } {
  const match = dataUrl.match(/^data:image\/(\w+);base64,/)
  const ext = match?.[1] ?? 'png'
  const b64 = dataUrl.replace(/^data:[^;]+;base64,/, '')
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return { ext, bytes }
}

/** 将二进制数据还原为 dataUrl */
function bytesToDataUrl(bytes: Uint8Array, filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png'
  const mimeMap: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }
  const mime = mimeMap[ext] ?? 'image/png'
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return `data:${mime};base64,${btoa(binary)}`
}

/** 导出数据为 ZIP */
export async function exportData() {
  try {
    const tasks = await getAllTasks()
    const templates = await getAllTemplates()
    const images = await getAllImages()
    const { settings } = useStore.getState()
    const exportedAt = Date.now()
    const imageCreatedAtFallback = new Map<string, number>()

    for (const task of tasks) {
      for (const id of [
        ...(task.inputImageIds || []),
        ...(task.maskImageId ? [task.maskImageId] : []),
        ...(task.outputImages || []),
      ]) {
        const prev = imageCreatedAtFallback.get(id)
        if (prev == null || task.createdAt < prev) {
          imageCreatedAtFallback.set(id, task.createdAt)
        }
      }
    }
    for (const template of templates) {
      if (template.coverImageId && !imageCreatedAtFallback.has(template.coverImageId)) {
        imageCreatedAtFallback.set(template.coverImageId, template.createdAt)
      }
    }

    const imageFiles: ExportData['imageFiles'] = {}
    const zipFiles: Record<string, Uint8Array | [Uint8Array, { mtime: Date }]> = {}

    for (const img of images) {
      const { ext, bytes } = dataUrlToBytes(img.dataUrl)
      const path = `images/${img.id}.${ext}`
      const createdAt = img.createdAt ?? imageCreatedAtFallback.get(img.id) ?? exportedAt
      imageFiles[img.id] = { path, createdAt, source: img.source }
      zipFiles[path] = [bytes, { mtime: new Date(createdAt) }]
    }

    const manifest: ExportData = {
      version: 3,
      exportedAt: new Date(exportedAt).toISOString(),
      settings,
      tasks,
      templates,
      imageFiles,
    }

    zipFiles['manifest.json'] = [strToU8(JSON.stringify(manifest, null, 2)), { mtime: new Date(exportedAt) }]

    const zipped = zipSync(zipFiles, { level: 6 })
    const blob = new Blob([zipped.buffer as ArrayBuffer], { type: 'application/zip' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `gpt-image-playground-${Date.now()}.zip`
    a.click()
    URL.revokeObjectURL(url)
    useStore.getState().showToast('数据已导出', 'success')
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
    const buffer = await file.arrayBuffer()
    const unzipped = unzipSync(new Uint8Array(buffer))

    const manifestBytes = unzipped['manifest.json']
    if (!manifestBytes) throw new Error('ZIP 中缺少 manifest.json')

    const data: ExportData = JSON.parse(strFromU8(manifestBytes))
    if (!data.tasks || !data.imageFiles) throw new Error('无效的数据格式')

    // 还原图片
    for (const [id, info] of Object.entries(data.imageFiles)) {
      const bytes = unzipped[info.path]
      if (!bytes) continue
      const dataUrl = bytesToDataUrl(bytes, info.path)
      await putImage({ id, dataUrl, createdAt: info.createdAt, source: info.source })
      imageCache.set(id, dataUrl)
    }

    for (const task of data.tasks) {
      await putTask(task)
    }
    for (const template of data.templates ?? []) {
      await putTemplate(template)
    }

    if (data.settings) {
      useStore.getState().setSettings(data.settings)
    }

    const tasks = await getAllTasks()
    const templates = await getAllTemplates()
    useStore.getState().setTasks(tasks)
    useStore.getState().setTemplates(templates)
    useStore
      .getState()
      .showToast(`已导入 ${data.tasks.length} 条记录`, 'success')
  } catch (e) {
    useStore
      .getState()
      .showToast(
        `导入失败：${e instanceof Error ? e.message : String(e)}`,
        'error',
      )
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
