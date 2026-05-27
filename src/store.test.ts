import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as backendApi from './lib/backendApi'
import { DEFAULT_PARAMS, DEFAULT_SETTINGS } from './types'
import type { TaskRecord } from './types'
import { editOutputs, removeMultipleTasks, removeTask, useStore } from './store'
import { submitTask } from './storeBackend'
import { moveTasksToProject, setTaskFavorite } from './storeTaskMutations'

const imageA = { id: 'image-a', dataUrl: 'data:image/png;base64,a' }

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
    ...overrides,
  }
}

describe('mask draft lifecycle in store actions', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        channelId: 'channel-a',
        model: 'gpt-image-2',
        apiMode: 'images',
      },
      backendUser: {
        id: 'user-a',
        username: 'alice',
        role: 'user',
        createdAt: 1,
        updatedAt: 1,
      },
      prompt: 'prompt',
      inputImages: [],
      maskDraft: null,
      maskEditorImageId: null,
      params: { ...DEFAULT_PARAMS },
      tasks: [],
      detailTaskId: null,
      lightboxImageId: null,
      lightboxImageList: [],
      showSettings: false,
      toast: null,
      confirmDialog: null,
      showToast: vi.fn(),
      setConfirmDialog: vi.fn(),
      setShowSettings: vi.fn(),
    })
  })

  it('clears an existing mask when quick edit-output adds outputs as references', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: imageA.id,
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await editOutputs(task({ outputImages: [imageA.id] }))

    expect(useStore.getState().maskDraft).toBeNull()
  })

  it('clears an invalid mask draft when submit cannot find the mask target image', async () => {
    useStore.setState({
      inputImages: [imageA],
      maskDraft: {
        targetImageId: 'missing-image',
        maskDataUrl: 'data:image/png;base64,mask',
        updatedAt: 1,
      },
    })

    await submitTask()

    expect(useStore.getState().maskDraft).toBeNull()
  })
})

describe('task server mutations', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        channelId: 'channel-a',
        model: 'gpt-image-2',
        apiMode: 'images',
      },
      backendUser: {
        id: 'user-a',
        username: 'alice',
        role: 'user',
        createdAt: 1,
        updatedAt: 1,
      },
      tasks: [],
      taskPage: { total: 0, loaded: 0, hasMore: false, loadingMore: false },
      inputImages: [],
      templates: [],
      selectedTaskIds: [],
      toast: null,
      showToast: vi.fn(),
    })
  })

  it('persists task favorite changes to the backend', async () => {
    const original = task({ isFavorite: false })
    const updated = { ...original, isFavorite: true }
    useStore.setState({ tasks: [original] })
    const patchGeneration = vi.spyOn(backendApi, 'patchGeneration').mockResolvedValue(updated)

    await setTaskFavorite(original.id, true)

    expect(patchGeneration).toHaveBeenCalledWith(expect.any(Object), original.id, { isFavorite: true })
    expect(useStore.getState().tasks[0]).toMatchObject({ id: original.id, isFavorite: true })
  })

  it('rolls back task favorite changes when backend patch fails', async () => {
    const original = task({ isFavorite: false })
    useStore.setState({ tasks: [original] })
    vi.spyOn(backendApi, 'patchGeneration').mockRejectedValue(new Error('boom'))

    await expect(setTaskFavorite(original.id, true)).rejects.toThrow('boom')

    expect(useStore.getState().tasks[0]).toMatchObject({ id: original.id, isFavorite: false })
    expect(useStore.getState().showToast).toHaveBeenCalledWith('更新记录失败：boom', 'error')
  })

  it('keeps a task when backend delete fails', async () => {
    const original = task()
    useStore.setState({
      tasks: [original],
      taskPage: { total: 1, loaded: 1, hasMore: false, loadingMore: false },
    })
    vi.spyOn(backendApi, 'deleteGeneration').mockRejectedValue(new Error('delete failed'))

    await removeTask(original)

    expect(useStore.getState().tasks).toEqual([original])
    expect(useStore.getState().taskPage).toMatchObject({ total: 1, loaded: 1 })
    expect(useStore.getState().showToast).toHaveBeenCalledWith('删除记录失败：delete failed', 'error')
  })

  it('keeps tasks when backend batch delete fails', async () => {
    const first = task({ id: 'task-a' })
    const second = task({ id: 'task-b' })
    useStore.setState({
      tasks: [first, second],
      taskPage: { total: 2, loaded: 2, hasMore: false, loadingMore: false },
      selectedTaskIds: [first.id, second.id],
    })
    vi.spyOn(backendApi, 'batchDeleteGenerations').mockRejectedValue(new Error('batch failed'))

    await removeMultipleTasks([first.id, second.id])

    expect(useStore.getState().tasks).toEqual([first, second])
    expect(useStore.getState().taskPage).toMatchObject({ total: 2, loaded: 2 })
    expect(useStore.getState().selectedTaskIds).toEqual([first.id, second.id])
    expect(useStore.getState().showToast).toHaveBeenCalledWith('批量删除失败：batch failed', 'error')
  })

  it('moves tasks to a target project', async () => {
    const first = task({ id: 'task-a', projectId: null })
    const second = task({ id: 'task-b', projectId: null })
    useStore.setState({ tasks: [first, second] })
    const patchGeneration = vi.spyOn(backendApi, 'patchGeneration').mockImplementation(async (_settings, taskId, patch) => ({
      ...(taskId === first.id ? first : second),
      ...patch,
    }))

    await moveTasksToProject([first.id, second.id], 'project-a')

    expect(patchGeneration).toHaveBeenCalledWith(expect.any(Object), first.id, { projectId: 'project-a' })
    expect(patchGeneration).toHaveBeenCalledWith(expect.any(Object), second.id, { projectId: 'project-a' })
    expect(useStore.getState().tasks.map((item) => item.projectId)).toEqual(['project-a', 'project-a'])
    expect(useStore.getState().showToast).toHaveBeenCalledWith('已移动 2 条记录', 'success')
  })

  it('clears task project assignment', async () => {
    const original = task({ projectId: 'project-a' })
    useStore.setState({ tasks: [original] })
    vi.spyOn(backendApi, 'patchGeneration').mockImplementation(async (_settings, _taskId, patch) => ({ ...original, ...patch }))

    await moveTasksToProject([original.id], null)

    expect(backendApi.patchGeneration).toHaveBeenCalledWith(expect.any(Object), original.id, { projectId: null })
    expect(useStore.getState().tasks[0]).toMatchObject({ id: original.id, projectId: null })
  })

  it('reports partial project move failures', async () => {
    const first = task({ id: 'task-a', projectId: null })
    const second = task({ id: 'task-b', projectId: null })
    useStore.setState({ tasks: [first, second] })
    vi.spyOn(backendApi, 'patchGeneration').mockImplementation(async (_settings, taskId, patch) => {
      if (taskId === second.id) throw new Error('move failed')
      return { ...first, ...patch }
    })

    await moveTasksToProject([first.id, second.id], 'project-a')

    expect(useStore.getState().tasks.find((item) => item.id === first.id)?.projectId).toBe('project-a')
    expect(useStore.getState().tasks.find((item) => item.id === second.id)?.projectId).toBeNull()
    expect(useStore.getState().showToast).toHaveBeenCalledWith('1 条记录移动失败', 'error')
  })
})
