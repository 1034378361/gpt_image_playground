import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PARAMS, DEFAULT_SETTINGS } from './types'
import type { TaskRecord } from './types'
import { imageCache, useStore } from './store'
import { importData, loadMoreServerTasks, loadMoreServerTemplates, syncServerData, retryTask, cancelMultipleTasks } from './storeBackend'
import * as backendApi from './lib/backendApi'
import { clearImages } from './lib/db'

vi.mock('./lib/backendApi', () => ({
  getMe: vi.fn(),
  listChannels: vi.fn(),
  listProjects: vi.fn(),
  listTemplates: vi.fn(),
  listGenerations: vi.fn(),
  listChannelLeaderboard: vi.fn(),
  getGenerationQueueStats: vi.fn(),
  listAdminChannels: vi.fn(),
  listAdminUsers: vi.fn(),
  listTemplateSubmissions: vi.fn(),
  listOpenPromptSources: vi.fn(),
  listAuditLogs: vi.fn(),
  importSystemBackup: vi.fn(),
  runGeneration: vi.fn(),
  cancelGeneration: vi.fn(),
  getGeneration: vi.fn(),
  streamGeneration: vi.fn(),
  getAssetDataUrl: vi.fn(),
}))

vi.mock('./lib/db', () => ({
  clearImages: vi.fn(),
  deleteImage: vi.fn(),
  evictOldImages: vi.fn(),
  getAllImages: vi.fn(),
  getAllTasks: vi.fn(),
  getAllTemplates: vi.fn(),
  clearTasks: vi.fn(),
  clearTemplates: vi.fn(),
  putImage: vi.fn(),
  putTask: vi.fn(),
  storeImage: vi.fn(),
}))

const mockedBackendApi = vi.mocked(backendApi)
const mockedClearImages = vi.mocked(clearImages)

function pageResult<T>(items: T[], options: { total?: number; limit?: number; offset?: number; hasMore?: boolean } = {}) {
  return {
    items,
    total: options.total ?? items.length,
    limit: options.limit ?? 80,
    offset: options.offset ?? 0,
    hasMore: options.hasMore ?? false,
  }
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    prompt: 'prompt',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1,
    finishedAt: 2,
    elapsed: 1,
    channelId: 'channel-a',
    apiMode: 'images',
    model: 'model-a',
    ...overrides,
  }
}

function resetStore() {
  useStore.setState({
    settings: {
      ...DEFAULT_SETTINGS,
      channelId: 'channel-a',
      model: 'model-a',
      apiMode: 'images',
      codexCli: false,
    },
    backendUser: {
      id: 'admin-1',
      username: 'alice',
      role: 'admin',
      createdAt: 1,
      updatedAt: 1,
    },
    backendReady: true,
    backendUnavailableReason: null,
    channels: [],
    adminChannels: [],
    adminUsers: [],
    auditLogs: [],
    openPromptSources: [],
    channelLeaderboard: [],
    queueStats: null,
    templateSubmissions: [],
    projects: [],
    currentProjectId: 'project-stale',
    pendingParentTaskId: null,
    generationPreflight: null,
    prompt: '',
    composerClearMode: 'prompt_only',
    theme: 'system',
    inputImages: [],
    maskDraft: null,
    maskEditorImageId: null,
    params: { ...DEFAULT_PARAMS },
    currentView: 'tasks',
    templates: [],
    templatePage: { total: 0, loaded: 0, hasMore: false, loadingMore: false },
    selectedTemplateId: null,
    selectedTemplateIds: [],
    templateEditor: null,
    templateVariableTemplateId: null,
    activeTemplateId: null,
    tasks: [],
    taskPage: { total: 0, loaded: 0, hasMore: false, loadingMore: false },
    searchQuery: '',
    filterStatus: 'all',
    filterFavorite: false,
    selectedTaskIds: [],
    detailTaskId: null,
    lightboxImageId: null,
    lightboxImageList: [],
    showProjectManager: false,
    showSettings: false,
    showUserSettings: false,
    toast: null,
    confirmDialog: null,
  })
}

describe('storeBackend state flows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    imageCache.clear()
    resetStore()
    mockedBackendApi.listChannels.mockResolvedValue([
      {
        id: 'channel-a',
        name: '主渠道',
        models: [{ id: 'model-a', label: 'Model A', apiMode: 'images', enabled: true }],
        timeoutSeconds: 30,
        codexCli: false,
        codexCliMode: 'auto',
        healthStatus: 'healthy',
        healthMessage: '',
        healthCheckedAt: 1,
        healthLatencyMs: 10,
        compatibilityStatus: 'standard',
        compatibilityMessage: '',
        compatibilityCheckedAt: 1,
        isEnabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    mockedBackendApi.listProjects.mockResolvedValue([
      {
        id: 'project-live',
        name: 'Live',
        description: '',
        color: '#3b82f6',
        isArchived: false,
        taskCount: 0,
        templateCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ])
    mockedBackendApi.listTemplates.mockResolvedValue(pageResult([]))
    mockedBackendApi.listGenerations.mockResolvedValue(pageResult([]))
    mockedBackendApi.listChannelLeaderboard.mockResolvedValue([])
    mockedBackendApi.getGenerationQueueStats.mockResolvedValue({
      workerCount: 1,
      queuedCount: 0,
      runningCount: 0,
      yourQueuedCount: 0,
      yourRunningCount: 0,
    })
    mockedBackendApi.listAdminChannels.mockResolvedValue([])
    mockedBackendApi.listAdminUsers.mockResolvedValue([])
    mockedBackendApi.listTemplateSubmissions.mockResolvedValue([])
    mockedBackendApi.listOpenPromptSources.mockResolvedValue([])
    mockedBackendApi.listAuditLogs.mockResolvedValue([])
    mockedBackendApi.getMe.mockResolvedValue({
      id: 'admin-1',
      username: 'alice',
      role: 'admin',
      createdAt: 1,
      updatedAt: 2,
    })
    mockedBackendApi.importSystemBackup.mockResolvedValue({ ok: true, restorePointName: 'restore-123' })
    mockedBackendApi.runGeneration.mockResolvedValue({ task: task({ status: 'queued', finishedAt: null, elapsed: null }) })
    mockedBackendApi.cancelGeneration.mockImplementation(async (_settings, taskId) => task({ id: taskId, status: 'canceled', error: '已取消' }))
    mockedBackendApi.getGeneration.mockResolvedValue(task())
    mockedBackendApi.streamGeneration.mockImplementation((taskId, onUpdate) => {
      Promise.resolve().then(() => onUpdate(task({ id: taskId, status: 'done' })))
      return vi.fn()
    })
    mockedBackendApi.getAssetDataUrl.mockResolvedValue('data:image/png;base64,a')
    mockedClearImages.mockResolvedValue(undefined)
  })

  it('syncServerData clears stale currentProjectId', async () => {
    await syncServerData()

    const state = useStore.getState()
    expect(state.channels).toHaveLength(1)
    expect(state.projects.map((project) => project.id)).toEqual(['project-live'])
    expect(state.currentProjectId).toBeNull()
    expect(state.settings.channelId).toBe('channel-a')
    expect(state.settings.model).toBe('model-a')
  })

  it('syncServerData writes paged task and template data', async () => {
    const template = { id: 'template-1', title: 'Template' } as any
    const task = { id: 'task-1', prompt: 'Task' } as any
    mockedBackendApi.listTemplates.mockResolvedValueOnce(pageResult([template], { total: 3, hasMore: true }))
    mockedBackendApi.listGenerations.mockResolvedValueOnce(pageResult([task], { total: 2, hasMore: true }))

    await syncServerData()

    const state = useStore.getState()
    expect(mockedBackendApi.listTemplates).toHaveBeenCalledWith(expect.any(Object), { limit: 80, offset: 0 })
    expect(mockedBackendApi.listGenerations).toHaveBeenCalledWith(expect.any(Object), { limit: 80, offset: 0 })
    expect(state.templates).toEqual([template])
    expect(state.tasks).toEqual([task])
    expect(state.templatePage).toMatchObject({ total: 3, loaded: 1, hasMore: true, loadingMore: false })
    expect(state.taskPage).toMatchObject({ total: 2, loaded: 1, hasMore: true, loadingMore: false })
  })

  it('syncServerData preserves the currently loaded task and template window', async () => {
    const currentTasks = Array.from({ length: 81 }, (_, index) => ({ id: `task-${index}`, prompt: `Task ${index}` }) as any)
    const currentTemplates = Array.from({ length: 82 }, (_, index) => ({ id: `template-${index}`, title: `Template ${index}` }) as any)
    const refreshedTasks = currentTasks.map((task) => ({ ...task, prompt: `${task.prompt} refreshed` }))
    const refreshedTemplates = currentTemplates.map((template) => ({ ...template, title: `${template.title} refreshed` }))
    useStore.setState({
      tasks: currentTasks,
      templates: currentTemplates,
      taskPage: { total: 120, loaded: currentTasks.length, hasMore: true, loadingMore: false },
      templatePage: { total: 130, loaded: currentTemplates.length, hasMore: true, loadingMore: false },
    })
    mockedBackendApi.listTemplates.mockResolvedValueOnce(
      pageResult(refreshedTemplates, { total: 130, limit: currentTemplates.length, hasMore: true }),
    )
    mockedBackendApi.listGenerations.mockResolvedValueOnce(
      pageResult(refreshedTasks, { total: 120, limit: currentTasks.length, hasMore: true }),
    )

    await syncServerData()

    expect(mockedBackendApi.listTemplates).toHaveBeenCalledWith(expect.any(Object), { limit: 82, offset: 0 })
    expect(mockedBackendApi.listGenerations).toHaveBeenCalledWith(expect.any(Object), { limit: 81, offset: 0 })
    expect(useStore.getState().templates).toEqual(refreshedTemplates)
    expect(useStore.getState().tasks).toEqual(refreshedTasks)
    expect(useStore.getState().templatePage).toMatchObject({ total: 130, loaded: 82, hasMore: true, loadingMore: false })
    expect(useStore.getState().taskPage).toMatchObject({ total: 120, loaded: 81, hasMore: true, loadingMore: false })
  })

  it('loadMoreServerTasks appends unique tasks and updates page state', async () => {
    const existingTask = { id: 'task-1', prompt: 'Existing' } as any
    const nextTask = { id: 'task-2', prompt: 'Next' } as any
    useStore.setState({
      tasks: [existingTask],
      taskPage: { total: 3, loaded: 1, hasMore: true, loadingMore: false },
    })
    mockedBackendApi.listGenerations.mockResolvedValueOnce(
      pageResult([existingTask, nextTask], { total: 3, offset: 1, hasMore: false }),
    )

    await loadMoreServerTasks()

    const state = useStore.getState()
    expect(mockedBackendApi.listGenerations).toHaveBeenCalledWith(expect.any(Object), { limit: 80, offset: 1 })
    expect(state.tasks).toEqual([existingTask, nextTask])
    expect(state.taskPage).toMatchObject({ total: 3, loaded: 2, hasMore: false, loadingMore: false })
  })

  it('loadMoreServerTemplates appends unique templates and skips unavailable pages', async () => {
    const existingTemplate = { id: 'template-1', title: 'Existing' } as any
    const nextTemplate = { id: 'template-2', title: 'Next' } as any
    useStore.setState({
      templates: [existingTemplate],
      templatePage: { total: 3, loaded: 1, hasMore: true, loadingMore: false },
    })
    mockedBackendApi.listTemplates.mockResolvedValueOnce(
      pageResult([existingTemplate, nextTemplate], { total: 3, offset: 1, hasMore: false }),
    )

    await loadMoreServerTemplates()

    expect(mockedBackendApi.listTemplates).toHaveBeenCalledWith(expect.any(Object), { limit: 80, offset: 1 })
    expect(useStore.getState().templates).toEqual([existingTemplate, nextTemplate])
    expect(useStore.getState().templatePage).toMatchObject({ total: 3, loaded: 2, hasMore: false, loadingMore: false })

    mockedBackendApi.listTemplates.mockClear()
    useStore.setState({ templatePage: { total: 2, loaded: 2, hasMore: false, loadingMore: false } })
    await loadMoreServerTemplates()
    expect(mockedBackendApi.listTemplates).not.toHaveBeenCalled()
  })

  it('retryTask ignores non-error tasks', async () => {
    const doneTask = task({ status: 'done' })
    useStore.setState({ tasks: [doneTask] })

    await retryTask(doneTask)

    expect(mockedBackendApi.runGeneration).not.toHaveBeenCalled()
    expect(useStore.getState().tasks[0]).toEqual(doneTask)
  })

  it('retryTask reruns failed tasks with the same task id', async () => {
    const failedTask = task({ status: 'error', error: 'upstream failed', outputImages: ['old-output'], finishedAt: 2, elapsed: 1 })
    const doneTask = task({ id: failedTask.id, status: 'done', error: null, outputImages: [] })
    useStore.setState({ tasks: [failedTask] })
    mockedBackendApi.listGenerations.mockResolvedValueOnce(pageResult([doneTask]))

    await retryTask(failedTask)

    expect(mockedBackendApi.runGeneration).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({
      taskId: failedTask.id,
      prompt: failedTask.prompt,
      inputImageDataUrls: [],
      maskDataUrl: undefined,
    }))
    expect(useStore.getState().tasks[0]).toMatchObject({ id: failedTask.id, status: 'done', error: null, outputImages: [] })
    expect(useStore.getState().toast).toMatchObject({ message: '后端生成完成，共 0 张图片', type: 'success' })
  })

  it('cancelMultipleTasks cancels only queued and running tasks', async () => {
    const queued = task({ id: 'queued-task', status: 'queued', finishedAt: null, elapsed: null })
    const running = task({ id: 'running-task', status: 'running', finishedAt: null, elapsed: null })
    const done = task({ id: 'done-task', status: 'done' })
    const error = task({ id: 'error-task', status: 'error', error: 'failed' })
    useStore.setState({ tasks: [queued, running, done, error] })

    await cancelMultipleTasks([queued.id, running.id, done.id, error.id])

    expect(mockedBackendApi.cancelGeneration).toHaveBeenCalledTimes(2)
    expect(mockedBackendApi.cancelGeneration).toHaveBeenCalledWith(expect.any(Object), queued.id)
    expect(mockedBackendApi.cancelGeneration).toHaveBeenCalledWith(expect.any(Object), running.id)
    expect(useStore.getState().tasks.filter((item) => item.status === 'canceled').map((item) => item.id).sort()).toEqual([
      queued.id,
      running.id,
    ].sort())
    expect(useStore.getState().toast).toMatchObject({ message: '已取消 2 个任务', type: 'success' })
  })

  it('importData rejects non-admin users before backend calls', async () => {
    useStore.setState({
      backendUser: {
        id: 'user-1',
        username: 'bob',
        role: 'user',
        createdAt: 1,
        updatedAt: 1,
      },
    })

    await importData(new File(['backup'], 'backup.zip', { type: 'application/zip' }))

    expect(mockedBackendApi.importSystemBackup).not.toHaveBeenCalled()
    expect(mockedClearImages).not.toHaveBeenCalled()
    expect(useStore.getState().toast?.type).toBe('error')
  })

  it('importData clears local image cache and resyncs server state', async () => {
    imageCache.set('asset-1', 'data:image/png;base64,aaa')

    await importData(new File(['backup'], 'backup.zip', { type: 'application/zip' }))

    expect(mockedBackendApi.importSystemBackup).toHaveBeenCalledTimes(1)
    expect(mockedClearImages).toHaveBeenCalledTimes(1)
    expect(mockedBackendApi.getMe).toHaveBeenCalledTimes(1)
    expect(mockedBackendApi.listChannels).toHaveBeenCalledTimes(1)
    expect(imageCache.size).toBe(0)
    expect(useStore.getState().backendUser?.updatedAt).toBe(2)
    expect(useStore.getState().projects.map((project) => project.id)).toEqual(['project-live'])
    expect(useStore.getState().toast?.type).toBe('success')
    expect(useStore.getState().toast?.message).toContain('restore-123')
  })
})
