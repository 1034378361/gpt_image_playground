import type {
  AdminUser,
  AdminApiChannel,
  ApiChannel,
  ApiChannelDraft,
  AppSettings,
  AuditLog,
  ChannelLeaderboardItem,
  GenerationPreflight,
  GenerationQueueStats,
  OpenPromptSourceStatus,
  PromptTemplate,
  PromptTemplateDraft,
  ProjectBoard,
  SystemBackupPreview,
  TaskParams,
  TaskRecord,
} from './types'
import { DEFAULT_PARAMS } from './types'
import {
  deleteImage,
  evictOldImages,
  getAllImages,
  getAllTasks,
  getAllTemplates,
  clearImages,
  clearTasks as dbClearTasks,
  clearTemplates as dbClearTemplates,
  putImage,
  putTask,
  storeImage,
} from './lib/db'
import { validateMaskMatchesImage } from './lib/canvasImage'
import { orderInputImagesForMask } from './lib/mask'
import { normalizeImageSize } from './lib/size'
import { normalizeSelectedProjectId } from './lib/templateUtils'
import * as backendApi from './lib/backendApi'
import {
  ensureImageCached,
  genId,
  getTemplateCoverImageIds,
  imageCache,
  isActiveTaskStatus,
  isServerStorageReady,
  linkTaskToTemplate,
  syncChannelSelection,
  updateTaskInStore,
  useStore,
} from './store'
import { canManageSystem, canReviewTemplates } from './lib/roles'
import { getTaskFailureSummary } from './lib/taskDiagnostics'

function resetSyncedServerState() {
  const state = useStore.getState()
  state.setTemplates([])
  state.setTasks([])
  state.setChannels([])
  state.setAdminChannels([])
  state.setAdminUsers([])
  state.setAuditLogs([])
  state.setOpenPromptSources([])
  state.setChannelLeaderboard([])
  state.setQueueStats(null)
  state.setTemplateSubmissions([])
  state.setProjects([])
  state.setCurrentProjectId(null)
  state.setPendingParentTaskId(null)
  state.setGenerationPreflight(null)
  state.setShowProjectManager(false)
  state.setShowSettings(false)
}

function describeBackendUnavailable(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  if (/Unexpected token|JSON|Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return '当前站点只加载到了前端静态文件，没有可用的 /api 后端服务。请按 README 以同源方式部署 FastAPI 后端，或在本地同时启动前后端。'
  }
  return `后端当前不可用：${message}`
}

export async function initStore() {
  useStore.getState().setSettings({})
  const [tasks, templates] = await Promise.all([getAllTasks(), getAllTemplates()])
  useStore.getState().setTasks(tasks)
  useStore.getState().setTemplates(templates)

  const referencedIds = new Set<string>()
  for (const task of tasks) {
    for (const id of task.inputImageIds || []) referencedIds.add(id)
    if (task.maskImageId) referencedIds.add(task.maskImageId)
    for (const id of task.outputImages || []) referencedIds.add(id)
  }
  for (const id of getTemplateCoverImageIds(templates)) {
    referencedIds.add(id)
  }

  const images = await getAllImages()
  const orphanIds: string[] = []
  for (const img of images) {
    if (referencedIds.has(img.id)) {
      imageCache.set(img.id, img.dataUrl)
    } else {
      orphanIds.push(img.id)
    }
  }

  if (orphanIds.length > 0) {
    void Promise.all(orphanIds.map((id) => deleteImage(id)))
  }
  void evictOldImages(referencedIds)

  await loadBackendSession({ silent: true })
}

interface PreparedTaskSubmission {
  prompt: string
  normalizedParams: TaskParams
  orderedInputImages: Array<{ id: string; dataUrl: string }>
  maskImageId: string | null
  maskTargetImageId: string | null
  sourceTemplate: PromptTemplate | null
  projectId: string | null
  parentTaskId: string | null
}

async function prepareTaskSubmission(options: { allowFullMask?: boolean } = {}): Promise<PreparedTaskSubmission | null> {
  const {
    settings,
    prompt,
    inputImages,
    maskDraft,
    params,
    activeTemplateId,
    templates,
    showToast,
    setConfirmDialog,
    channels,
    currentProjectId,
    pendingParentTaskId,
  } = useStore.getState()
  const backendUser = useStore.getState().backendUser

  if (!backendUser) {
    showToast('请先登录后端账户', 'error')
    return null
  }

  if (!settings.channelId || !settings.model) {
    showToast(
      canManageSystem(backendUser) || channels.length > 0
        ? '请先选择可用的渠道和模型'
        : '当前没有可用渠道，请联系管理员配置',
      'error',
    )
    if (canManageSystem(backendUser)) {
      useStore.getState().setShowSettings(true)
    }
    return null
  }

  if (!prompt.trim()) {
    showToast('请输入提示词', 'error')
    return null
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
        return null
      }
      maskImageId = await storeImage(maskDraft.maskDataUrl, 'mask')
      imageCache.set(maskImageId, maskDraft.maskDataUrl)
      maskTargetImageId = maskDraft.targetImageId
    } catch (err) {
      if (!inputImages.some((img) => img.id === maskDraft.targetImageId)) {
        useStore.getState().clearMaskDraft()
      }
      showToast(err instanceof Error ? err.message : String(err), 'error')
      return null
    }
  }

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

  const sourceTemplate = activeTemplateId
    ? templates.find((template) => template.id === activeTemplateId) ?? null
    : null

  return {
    prompt: prompt.trim(),
    normalizedParams,
    orderedInputImages,
    maskImageId,
    maskTargetImageId,
    sourceTemplate,
    projectId: normalizeSelectedProjectId(currentProjectId),
    parentTaskId: pendingParentTaskId,
  }
}

async function queuePreparedTask(
  prepared: PreparedTaskSubmission,
  overrides: {
    channelId?: string
    apiMode?: TaskRecord['apiMode']
    model?: string
    experimentId?: string | null
    variationLabel?: string | null
  } = {},
) {
  const taskId = genId()
  const settings = useStore.getState().settings
  const task: TaskRecord = {
    id: taskId,
    ...(prepared.sourceTemplate
      ? { templateId: prepared.sourceTemplate.id, templateVersionId: String(prepared.sourceTemplate.version) }
      : {}),
    projectId: prepared.projectId,
    parentTaskId: prepared.parentTaskId,
    experimentId: overrides.experimentId ?? null,
    variationLabel: overrides.variationLabel ?? null,
    prompt: prepared.prompt,
    params: prepared.normalizedParams,
    inputImageIds: prepared.orderedInputImages.map((i) => i.id),
    maskTargetImageId: prepared.maskTargetImageId,
    maskImageId: prepared.maskImageId,
    outputImages: [],
    status: 'queued',
    error: null,
    createdAt: Date.now(),
    finishedAt: null,
    elapsed: null,
    channelId: overrides.channelId || settings.channelId,
    apiMode: overrides.apiMode || settings.apiMode,
    model: overrides.model || settings.model,
  }

  useStore.getState().setTasks([task, ...useStore.getState().tasks])
  await putTask(task)

  if (prepared.sourceTemplate) {
    await linkTaskToTemplate(prepared.sourceTemplate.id, taskId)
  }

  void refreshQueueStats()
  void executeServerTask(taskId)
  return task
}

function clearComposerAfterTaskQueued() {
  const state = useStore.getState()
  const mode = state.composerClearMode

  if (mode === 'keep_all') {
    state.setGenerationPreflight(null)
    state.setPendingParentTaskId(null)
    return
  }

  state.setPrompt('')
  state.setGenerationPreflight(null)
  state.setPendingParentTaskId(null)

  if (mode === 'prompt_and_images') {
    state.clearInputImages()
    state.clearMaskDraft()
  }
}

export async function submitTask(options: { allowFullMask?: boolean } = {}) {
  const prepared = await prepareTaskSubmission(options)
  if (!prepared) return null
  const task = await queuePreparedTask(prepared)
  clearComposerAfterTaskQueued()
  return task
}

export async function generateVariation(sourceTask: TaskRecord, imageId: string) {
  const { backendUser, settings, channels, showToast } = useStore.getState()
  if (!backendUser) {
    showToast('请先登录', 'error')
    return
  }
  if (!settings.channelId || !settings.model) {
    showToast('请先选择渠道和模型', 'error')
    return
  }

  const dataUrl = await ensureImageCached(imageId)
  if (!dataUrl) {
    showToast('图片已不可用', 'error')
    return
  }

  const normalizedParams = {
    ...sourceTask.params,
    size: normalizeImageSize(sourceTask.params.size) || DEFAULT_PARAMS.size,
  }

  const task = await queuePreparedTask({
    prompt: sourceTask.prompt,
    normalizedParams,
    orderedInputImages: [{ id: imageId, dataUrl }],
    maskImageId: null,
    maskTargetImageId: null,
    sourceTemplate: null,
    projectId: sourceTask.projectId ?? null,
    parentTaskId: sourceTask.id,
  })

  await storeImage(dataUrl)
  showToast('已提交变体生成', 'success')
  return task
}

export async function submitTaskMatrix(
  variants: Array<{
    channelId: string
    model: string
    apiMode: TaskRecord['apiMode']
    params?: Partial<TaskParams>
    variationLabel: string
  }>,
) {
  const prepared = await prepareTaskSubmission()
  if (!prepared) return
  const experimentId = genId()
  const limit = Math.min(12, variants.length)
  for (const variant of variants.slice(0, limit)) {
    await queuePreparedTask(
      {
        ...prepared,
        normalizedParams: { ...prepared.normalizedParams, ...(variant.params ?? {}) },
      },
      {
        channelId: variant.channelId,
        model: variant.model,
        apiMode: variant.apiMode,
        experimentId,
        variationLabel: variant.variationLabel,
      },
    )
  }
  clearComposerAfterTaskQueued()
  useStore.getState().showToast(`已启动 ${limit} 组对比实验`, 'success')
}

export async function refreshGenerationPreflight() {
  const { backendUser, settings, prompt, params, inputImages, maskDraft, setGenerationPreflight } = useStore.getState()
  if (!backendUser || !settings.channelId || !settings.model || !prompt.trim()) {
    setGenerationPreflight(null)
    return
  }
  try {
    const preflight = await backendApi.getGenerationPreflight(settings, {
      channelId: settings.channelId,
      model: settings.model,
      prompt,
      params,
      inputImageCount: inputImages.length,
      hasMask: Boolean(maskDraft),
    })
    setGenerationPreflight(preflight)
  } catch {
    setGenerationPreflight(null)
  }
}

function waitForTaskCompletion(taskId: string, timeoutSeconds: number): Promise<TaskRecord> {
  const { settings } = useStore.getState()
  const deadline = Date.now() + Math.max(30_000, timeoutSeconds * 1000 + 15_000)

  return new Promise<TaskRecord>((resolve, reject) => {
    let settled = false
    let lastTask: TaskRecord | null = null

    const settle = () => {
      if (settled) return false
      settled = true
      close()
      window.clearTimeout(timeoutId)
      return true
    }

    const close = backendApi.streamGeneration(
      taskId,
      (task) => {
        lastTask = task
        updateTaskInStore(taskId, task)
        const localTask = useStore.getState().tasks.find((item) => item.id === taskId)
        if (localTask?.status === 'canceled' || !isActiveTaskStatus(task.status)) {
          if (settle()) resolve(task)
        }
      },
      () => {
        if (settle()) fallbackPolling(taskId, settings, deadline).then(resolve, reject)
      },
    )

    const timeoutId = window.setTimeout(() => {
      if (!settle()) return
      if (lastTask && !isActiveTaskStatus(lastTask.status)) {
        resolve(lastTask)
      } else {
        fallbackPolling(taskId, settings, deadline).then(resolve, reject)
      }
    }, Math.max(1000, deadline - Date.now()))

    const checkCancel = () => {
      if (settled) return
      const localTask = useStore.getState().tasks.find((item) => item.id === taskId)
      if (localTask?.status === 'canceled') {
        if (settle()) resolve(localTask as unknown as TaskRecord)
      } else {
        window.setTimeout(checkCancel, 2000)
      }
    }
    window.setTimeout(checkCancel, 2000)
  })
}

async function fallbackPolling(taskId: string, settings: AppSettings, deadline: number): Promise<TaskRecord> {
  let serverTask = await backendApi.getGeneration(settings, taskId)
  while (isActiveTaskStatus(serverTask.status) && Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 1500))
    const localTask = useStore.getState().tasks.find((item) => item.id === taskId)
    if (localTask?.status === 'canceled') return serverTask
    serverTask = await backendApi.getGeneration(settings, taskId)
    updateTaskInStore(taskId, serverTask)
  }
  return serverTask
}

async function executeServerTask(taskId: string) {
  const { settings } = useStore.getState()
  const task = useStore.getState().tasks.find((item) => item.id === taskId)
  if (!task) return
  const channel = useStore.getState().channels.find((item) => item.id === (task.channelId || settings.channelId))
  const timeoutSeconds = channel?.timeoutSeconds ?? 300

  try {
    const inputDataUrls = await Promise.all(
      task.inputImageIds.map(async (imgId) => {
        const dataUrl = await ensureImageCached(imgId)
        if (!dataUrl) throw new Error('输入图片已不存在')
        return dataUrl
      }),
    )
    let maskDataUrl: string | undefined
    if (task.maskImageId) {
      maskDataUrl = await ensureImageCached(task.maskImageId)
      if (!maskDataUrl) throw new Error('遮罩图片已不存在')
    }

    const started = await backendApi.runGeneration(settings, {
      taskId,
      templateId: task.templateId,
      templateVersionId: task.templateVersionId,
      projectId: task.projectId,
      parentTaskId: task.parentTaskId,
      experimentId: task.experimentId,
      variationLabel: task.variationLabel,
      channelId: task.channelId || settings.channelId,
      model: task.model || settings.model,
      prompt: task.prompt,
      params: task.params,
      inputImageDataUrls: inputDataUrls,
      maskDataUrl,
    })

    const localAfterStart = useStore.getState().tasks.find((item) => item.id === taskId)
    if (localAfterStart?.status === 'canceled') {
      await backendApi.cancelGeneration(settings, taskId).catch(() => undefined)
      return
    }
    updateTaskInStore(taskId, started.task)

    const serverTask = await waitForTaskCompletion(taskId, timeoutSeconds)

    if (isActiveTaskStatus(serverTask.status)) {
      throw new Error('后端生成仍在进行中，请稍后同步任务状态')
    }
    if (serverTask.status === 'canceled') {
      updateTaskInStore(taskId, serverTask)
      void refreshQueueStats()
      useStore.getState().showToast('任务已取消', 'info')
      return
    }
    if (serverTask.status === 'error') {
      updateTaskInStore(taskId, serverTask)
      void refreshQueueStats()
      const latestTask = useStore.getState().tasks.find((item) => item.id === taskId)
      useStore.getState().showToast(`生成失败：${latestTask ? getTaskFailureSummary(latestTask) : '请查看详情'}`, 'error')
      useStore.getState().setDetailTaskId(taskId)
      return
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
    await syncServerData()
    useStore.getState().showToast(`后端生成完成，共 ${outputIds.length} 张图片`, 'success')
  } catch (err) {
    if (useStore.getState().tasks.find((item) => item.id === taskId)?.status === 'canceled') {
      return
    }
    updateTaskInStore(taskId, {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      finishedAt: Date.now(),
      elapsed: Date.now() - task.createdAt,
    })
    const latestTask = useStore.getState().tasks.find((item) => item.id === taskId)
    useStore.getState().showToast(`生成失败：${latestTask ? getTaskFailureSummary(latestTask) : '请查看详情'}`, 'error')
    useStore.getState().setDetailTaskId(taskId)
  }
  void refreshQueueStats()

  for (const imgId of task.inputImageIds) {
    imageCache.delete(imgId)
  }
}

export async function cancelTask(task: TaskRecord) {
  if (!isActiveTaskStatus(task.status)) return
  const finishedAt = Date.now()
  updateTaskInStore(task.id, {
    status: 'canceled',
    error: '已取消',
    finishedAt,
    elapsed: Math.max(0, finishedAt - task.createdAt),
  })

  try {
    if (isServerStorageReady()) {
      const serverTask = await backendApi.cancelGeneration(useStore.getState().settings, task.id)
      updateTaskInStore(task.id, serverTask)
    }
    void refreshQueueStats()
    useStore.getState().showToast('任务已取消', 'success')
  } catch (err) {
    useStore.getState().showToast(`取消任务失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    await syncServerData()
  }
}

export async function loadBackendSession(options: { silent?: boolean } = {}) {
  const state = useStore.getState()
  try {
    const user = await backendApi.getMe(state.settings)
    useStore.getState().setBackendUser(user)
    useStore.getState().setBackendUnavailableReason(null)
    await syncServerData()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const authError =
      /not authenticated|unauthorized|401|未登录|登录/i.test(message) ||
      message.includes('Authentication required')
    useStore.getState().setBackendUser(null)
    resetSyncedServerState()
    if (authError) {
      useStore.getState().setBackendUnavailableReason(null)
      if (!options.silent) {
        useStore.getState().showToast(`后端未登录：${message}`, 'error')
      }
    } else {
      useStore.getState().setBackendUnavailableReason(describeBackendUnavailable(err))
      if (!options.silent) {
        useStore.getState().showToast(describeBackendUnavailable(err), 'error')
      }
    }
  } finally {
    useStore.getState().setBackendReady(true)
  }
}

export async function loginBackend(username: string, password: string) {
  const { settings, showToast } = useStore.getState()
  const user = await backendApi.login(settings, username, password)
  useStore.getState().setBackendUser(user)
  useStore.getState().setBackendUnavailableReason(null)
  await syncServerData()
  showToast('登录成功', 'success')
}

export async function registerBackend(username: string, password: string, inviteCode?: string) {
  const { settings, showToast } = useStore.getState()
  const user = await backendApi.register(settings, username, password, inviteCode)
  useStore.getState().setBackendUser(user)
  useStore.getState().setBackendUnavailableReason(null)
  await syncServerData()
  showToast('注册并登录成功', 'success')
}

export async function logoutBackend() {
  const { settings, showToast } = useStore.getState()
  await backendApi.logout(settings)
  useStore.getState().setBackendUser(null)
  useStore.getState().setShowUserSettings(false)
  resetSyncedServerState()
  imageCache.clear()
  void dbClearTasks()
  void dbClearTemplates()
  void clearImages()
  showToast('已退出登录', 'success')
}

export async function syncServerData() {
  const {
    settings,
    backendUser,
    setTemplates,
    setTasks,
    setChannels,
    setAdminChannels,
    setAdminUsers,
    setAuditLogs,
    setOpenPromptSources,
    setChannelLeaderboard,
    setQueueStats,
    setTemplateSubmissions,
    setProjects,
    currentProjectId,
    setCurrentProjectId,
    showToast,
  } = useStore.getState()
  if (!backendUser) return

  try {
    const systemManager = canManageSystem(backendUser)
    const templateReviewer = canReviewTemplates(backendUser)

    const [
      channels,
      projects,
      templates,
      tasks,
      channelLeaderboard,
      queueStats,
    ] = await Promise.all([
      backendApi.listChannels(settings),
      backendApi.listProjects(settings),
      backendApi.listTemplates(settings),
      backendApi.listGenerations(settings),
      backendApi.listChannelLeaderboard(settings),
      backendApi.getGenerationQueueStats(settings),
    ]) as [
      ApiChannel[],
      ProjectBoard[],
      PromptTemplate[],
      TaskRecord[],
      ChannelLeaderboardItem[],
      GenerationQueueStats,
    ]

    setChannels(channels)
    setProjects(projects)
    setTemplates(templates)
    setTasks(tasks)
    setChannelLeaderboard(channelLeaderboard)
    setQueueStats(queueStats)
    syncChannelSelection(channels)
    if (currentProjectId && !projects.some((project) => project.id === currentProjectId)) {
      setCurrentProjectId(null)
    }

    void syncAdminData(settings, systemManager, templateReviewer, {
      setAdminChannels, setAdminUsers, setTemplateSubmissions,
      setOpenPromptSources, setAuditLogs,
    })
  } catch (err) {
    showToast(`同步后端数据失败：${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}

async function syncAdminData(
  settings: AppSettings,
  systemManager: boolean,
  templateReviewer: boolean,
  setters: {
    setAdminChannels: (v: AdminApiChannel[]) => void
    setAdminUsers: (v: AdminUser[]) => void
    setTemplateSubmissions: (v: PromptTemplate[]) => void
    setOpenPromptSources: (v: OpenPromptSourceStatus[]) => void
    setAuditLogs: (v: AuditLog[]) => void
  },
) {
  try {
    const [
      adminChannels, adminUsers, templateSubmissions, openPromptSources,
      auditLogs,
    ] = await Promise.all([
      systemManager ? backendApi.listAdminChannels(settings) : Promise.resolve([]),
      systemManager ? backendApi.listAdminUsers(settings) : Promise.resolve([]),
      templateReviewer ? backendApi.listTemplateSubmissions(settings) : Promise.resolve([]),
      templateReviewer ? backendApi.listOpenPromptSources(settings) : Promise.resolve([]),
      systemManager ? backendApi.listAuditLogs(settings) : Promise.resolve([]),
    ]) as [
      AdminApiChannel[], AdminUser[], PromptTemplate[], OpenPromptSourceStatus[],
      AuditLog[],
    ]
    setters.setAdminChannels(adminChannels)
    setters.setAdminUsers(adminUsers)
    setters.setTemplateSubmissions(templateSubmissions)
    setters.setOpenPromptSources(openPromptSources)
    setters.setAuditLogs(auditLogs)
  } catch { /* admin data sync failure is non-critical */ }
}

export async function refreshQueueStats() {
  const { settings, backendUser, setQueueStats } = useStore.getState()
  if (!backendUser) return
  try {
    const stats = await backendApi.getGenerationQueueStats(settings)
    setQueueStats(stats)
  } catch {
    /* queue stats are supplementary */
  }
}

export async function saveProject(projectId: string | null, payload: { name: string; description: string; color: string; isArchived?: boolean }) {
  const { settings, projects, setProjects, showToast, currentProjectId, setCurrentProjectId } = useStore.getState()
  const saved = projectId
    ? await backendApi.patchProject(settings, projectId, payload)
    : await backendApi.createProject(settings, payload)
  const nextProjects = projectId
    ? projects.map((project) => (project.id === projectId ? saved : project))
    : [saved, ...projects]
  setProjects(nextProjects)
  if (!currentProjectId && !saved.isArchived) {
    setCurrentProjectId(saved.id)
  }
  showToast(projectId ? '项目已更新' : '项目已创建', 'success')
}

export async function removeProject(projectId: string) {
  const { settings, projects, setProjects, currentProjectId, setCurrentProjectId, showToast } = useStore.getState()
  await backendApi.deleteProject(settings, projectId)
  setProjects(projects.filter((project) => project.id !== projectId))
  if (currentProjectId === projectId) {
    setCurrentProjectId(null)
  }
  showToast('项目已删除', 'success')
  await syncServerData()
}

export async function submitTemplateForReview(templateId: string) {
  const { settings, templates, setTemplates, showToast } = useStore.getState()
  const updated = await backendApi.submitTemplate(settings, templateId)
  setTemplates(templates.map((template) => (template.id === templateId ? updated : template)))
  showToast('已提交到公共模板审核队列', 'success')
}

export async function approveTemplate(templateId: string) {
  const { settings, templates, templateSubmissions, setTemplates, setTemplateSubmissions, showToast } = useStore.getState()
  const updated = await backendApi.approveTemplateSubmission(settings, templateId)
  const nextTemplates = templates.some((template) => template.id === templateId)
    ? templates.map((template) => (template.id === templateId ? updated : template))
    : [updated, ...templates]
  setTemplates(nextTemplates)
  setTemplateSubmissions(templateSubmissions.filter((template) => template.id !== templateId))
  showToast('模板已加入公共模板库', 'success')
}

export async function rejectTemplate(templateId: string, reason = '') {
  const { settings, templates, templateSubmissions, setTemplates, setTemplateSubmissions, showToast } = useStore.getState()
  const updated = await backendApi.rejectTemplateSubmission(settings, templateId, reason)
  const nextTemplates = templates.some((template) => template.id === templateId)
    ? templates.map((template) => (template.id === templateId ? updated : template))
    : [updated, ...templates]
  setTemplates(nextTemplates)
  setTemplateSubmissions(templateSubmissions.filter((template) => template.id !== templateId))
  showToast('已驳回模板投稿', 'success')
}

export async function importOpenPromptLibrary(
  source: backendApi.OpenPromptLibrarySourceId = 'evolink',
  limit = 0,
  selectedKeys: string[] = [],
) {
  const { settings, showToast } = useStore.getState()
  const selectedSource = backendApi.OPEN_PROMPT_LIBRARY_SOURCES.find((item) => item.id === source)
  const result = await backendApi.importOpenPromptLibraryTemplates(settings, source, limit, selectedKeys)
  const sourceLabel = selectedSource?.label ?? result.source
  showToast(
    `${sourceLabel}：已导入 ${result.created} 个精选模板，更新 ${result.updated} 个来源说明，跳过 ${result.skipped} 个重复项`,
    'success',
  )
  await syncServerData()
}

export async function saveAdminChannel(channelId: string | null, payload: ApiChannelDraft) {
  const { settings, adminChannels, showToast } = useStore.getState()
  const saved = channelId
    ? await backendApi.patchChannel(settings, channelId, payload)
    : await backendApi.createChannel(settings, payload)
  const nextChannels = channelId
    ? adminChannels.map((channel) => (channel.id === channelId ? saved : channel))
    : [saved, ...adminChannels]
  useStore.getState().setAdminChannels(nextChannels)
  showToast(channelId ? '渠道已更新' : '渠道已创建', 'success')
  await syncServerData()
}

export async function updateAdminUserRole(userId: string, role: AdminUser['role']) {
  const { settings, showToast } = useStore.getState()
  await backendApi.patchAdminUserRole(settings, userId, role)
  await syncServerData()
  showToast('用户角色已更新', 'success')
}

export async function previewSystemBackupFile(file: File): Promise<SystemBackupPreview> {
  const { settings, backendUser } = useStore.getState()
  if (!backendUser || !canManageSystem(backendUser)) {
    throw new Error('只有管理员可以预览服务端备份')
  }
  return backendApi.previewSystemBackup(settings, file)
}

export async function testAdminChannelHealth(channelId: string) {
  const { settings, adminChannels, showToast } = useStore.getState()
  const checked = await backendApi.checkChannelHealth(settings, channelId)
  useStore.getState().setAdminChannels(adminChannels.map((channel) => (channel.id === channelId ? checked : channel)))
  showToast(`渠道健康度：${checked.healthMessage || checked.healthStatus}`, checked.healthStatus === 'error' ? 'error' : 'success')
  await syncServerData()
}

export async function testAdminChannelCompatibility(channelId: string) {
  const { settings, adminChannels, showToast } = useStore.getState()
  const checked = await backendApi.checkChannelCompatibility(settings, channelId)
  useStore.getState().setAdminChannels(adminChannels.map((channel) => (channel.id === channelId ? checked : channel)))
  showToast(
    `接口兼容性：${checked.compatibilityMessage || checked.compatibilityStatus}`,
    checked.compatibilityStatus === 'error' ? 'error' : 'success',
  )
  await syncServerData()
}

export async function removeAdminChannel(channelId: string) {
  const { settings, adminChannels, showToast } = useStore.getState()
  await backendApi.deleteChannel(settings, channelId)
  useStore.getState().setAdminChannels(adminChannels.filter((channel) => channel.id !== channelId))
  showToast('渠道已删除', 'success')
  await syncServerData()
}

export async function importTemplatePackFile(file: File) {
  try {
    const text = await file.text()
    const parsed = JSON.parse(text)
    const templates = Array.isArray(parsed) ? parsed : parsed.templates
    if (!Array.isArray(templates)) throw new Error('模板包格式无效')
    const result = await backendApi.importTemplatePack(useStore.getState().settings, templates)
    await syncServerData()
    useStore.getState().showToast(`模板包已导入 ${result.created} 个，跳过 ${result.skipped} 个`, 'success')
  } catch (err) {
    useStore.getState().showToast(`模板包导入失败：${err instanceof Error ? err.message : String(err)}`, 'error')
  }
}
