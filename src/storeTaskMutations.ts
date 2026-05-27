import { normalizeSelectedProjectId } from './lib/templateUtils'
import type { TaskRecord } from './types'
import * as backendApi from './lib/backendApi'
import { putTask } from './lib/db'
import { useStore } from './store'

interface PatchTaskOptions {
  silentError?: boolean
}

function describeTaskPatchError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function buildRollbackPatch(existing: TaskRecord, patch: Partial<TaskRecord>): Partial<TaskRecord> {
  const rollback: Partial<TaskRecord> = {}
  for (const key of Object.keys(patch) as Array<keyof TaskRecord>) {
    rollback[key] = existing[key] as never
  }
  return rollback
}

export function updateTaskInStore(taskId: string, patch: Partial<TaskRecord>) {
  const { tasks, setTasks } = useStore.getState()
  let updatedTask: TaskRecord | null = null
  const updated = tasks.map((task) => {
    if (task.id !== taskId) return task
    updatedTask = { ...task, ...patch }
    return updatedTask
  })
  if (!updatedTask) return

  setTasks(updated)
  void Promise.resolve(putTask(updatedTask)).catch(() => undefined)
}

async function patchTaskInStore(
  taskId: string,
  patch: Partial<TaskRecord>,
  options: PatchTaskOptions = {},
): Promise<TaskRecord | null> {
  const existing = useStore.getState().tasks.find((task) => task.id === taskId)
  if (!existing) return null

  updateTaskInStore(taskId, patch)

  if (!useStore.getState().backendUser) {
    return { ...existing, ...patch }
  }

  try {
    const updated = await backendApi.patchGeneration(useStore.getState().settings, taskId, patch)
    updateTaskInStore(taskId, updated)
    return updated
  } catch (err) {
    updateTaskInStore(taskId, buildRollbackPatch(existing, patch))
    if (!options.silentError) {
      useStore.getState().showToast(`更新记录失败：${describeTaskPatchError(err)}`, 'error')
    }
    throw err
  }
}

export function setTaskFavorite(
  taskId: string,
  isFavorite: boolean,
  options?: PatchTaskOptions,
): Promise<TaskRecord | null> {
  return patchTaskInStore(taskId, { isFavorite }, options)
}

export async function moveTasksToProject(taskIds: string[], projectId: string | null): Promise<void> {
  if (!taskIds.length) return
  const targetProjectId = normalizeSelectedProjectId(projectId)
  const results = await Promise.allSettled(
    taskIds.map((taskId) => patchTaskInStore(taskId, { projectId: targetProjectId }, { silentError: true })),
  )
  const failed = results.filter((result) => result.status === 'rejected').length
  if (failed > 0) {
    useStore.getState().showToast(`${failed} 条记录移动失败`, 'error')
  } else {
    useStore.getState().showToast(`已移动 ${taskIds.length} 条记录`, 'success')
  }
}
