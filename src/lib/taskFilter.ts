import type { TaskRecord } from '../types'
import { UNASSIGNED_PROJECT_ID } from './templateUtils'

export interface TaskFilterCriteria {
  currentProjectId: string | null
  filterStatus: string
  filterFavorite: boolean
  searchQuery: string
}

/**
 * Filters and sorts tasks for gallery display.
 *
 * This is the single source of truth shared by the gallery grid (TaskGrid) and
 * the batch "select all" action (InputBar). Keeping them in sync matters: when
 * the two diverged, "select all" selected every task in the account instead of
 * just the visible ones for the current project.
 */
export function filterTasks(tasks: TaskRecord[], criteria: TaskFilterCriteria): TaskRecord[] {
  const { currentProjectId, filterStatus, filterFavorite, searchQuery } = criteria
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
  const q = searchQuery.trim().toLowerCase()

  return sorted.filter((t) => {
    if (filterFavorite && !t.isFavorite) return false
    if (currentProjectId === UNASSIGNED_PROJECT_ID && t.projectId) return false
    if (currentProjectId && currentProjectId !== UNASSIGNED_PROJECT_ID && t.projectId !== currentProjectId) return false
    const matchStatus = filterStatus === 'all' || t.status === filterStatus
    if (!matchStatus) return false

    if (!q) return true
    const prompt = (t.prompt || '').toLowerCase()
    const paramStr = JSON.stringify(t.params).toLowerCase()
    return prompt.includes(q) || paramStr.includes(q)
  })
}
