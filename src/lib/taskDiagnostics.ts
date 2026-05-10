import type { GenerationDiagnostic, TaskRecord } from '../types'

function trimErrorMessage(message: string): string {
  const normalized = message.trim()
  if (!normalized) return '生成失败'
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized
}

export function getPrimaryDiagnostic(task: TaskRecord): GenerationDiagnostic | null {
  const diagnostics = task.diagnostics ?? []
  const errorItem = diagnostics.find((item) => item.level === 'error')
  return errorItem ?? diagnostics[0] ?? null
}

export function getTaskFailureSummary(task: TaskRecord): string {
  const diagnostic = getPrimaryDiagnostic(task)
  if (diagnostic?.title?.trim()) return diagnostic.title.trim()
  if (task.error?.trim()) return trimErrorMessage(task.error)
  return '生成失败'
}

export function getTaskFailureDetail(task: TaskRecord): string {
  const diagnostic = getPrimaryDiagnostic(task)
  if (diagnostic) {
    const parts = [diagnostic.title?.trim(), diagnostic.detail?.trim(), diagnostic.hint?.trim()].filter(Boolean)
    if (parts.length > 0) return parts.join('\n')
  }
  if (task.error?.trim()) return task.error.trim()
  return '生成失败'
}

export function getTaskQueuePosition(tasks: TaskRecord[], taskId: string): number | null {
  const queued = [...tasks]
    .filter((task) => task.status === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt)
  const index = queued.findIndex((task) => task.id === taskId)
  return index >= 0 ? index + 1 : null
}
