import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import type { TaskRecord } from '../types'
import { filterTasks } from './taskFilter'

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 'task-a',
    projectId: null,
    prompt: 'a clean product photo',
    params: { ...DEFAULT_PARAMS },
    inputImageIds: [],
    outputImages: [],
    status: 'done',
    error: null,
    createdAt: 1000,
    finishedAt: 2000,
    elapsed: 1000,
    isFavorite: false,
    ...overrides,
  }
}

const noFilters = {
  currentProjectId: null,
  filterStatus: 'all',
  filterFavorite: false,
  searchQuery: '',
}

describe('filterTasks', () => {
  it('returns all tasks sorted by createdAt descending when no filters apply', () => {
    const older = task({ id: 'older', createdAt: 1000 })
    const newer = task({ id: 'newer', createdAt: 5000 })
    const result = filterTasks([older, newer], noFilters)
    expect(result.map((t) => t.id)).toEqual(['newer', 'older'])
  })

  // The regression this function exists to prevent: "select all" must scope to
  // the current project, not the whole account.
  it('keeps only tasks for the selected project', () => {
    const inProject = task({ id: 'in', projectId: 'proj-1' })
    const otherProject = task({ id: 'other', projectId: 'proj-2' })
    const unassigned = task({ id: 'free', projectId: null })
    const result = filterTasks([inProject, otherProject, unassigned], {
      ...noFilters,
      currentProjectId: 'proj-1',
    })
    expect(result.map((t) => t.id)).toEqual(['in'])
  })

  it('keeps only unassigned tasks in the unassigned view', () => {
    const assigned = task({ id: 'assigned', projectId: 'proj-1' })
    const unassigned = task({ id: 'free', projectId: null })
    const result = filterTasks([assigned, unassigned], {
      ...noFilters,
      currentProjectId: '__unassigned__',
    })
    expect(result.map((t) => t.id)).toEqual(['free'])
  })

  it('filters by favorite', () => {
    const fav = task({ id: 'fav', isFavorite: true })
    const plain = task({ id: 'plain', isFavorite: false })
    const result = filterTasks([fav, plain], { ...noFilters, filterFavorite: true })
    expect(result.map((t) => t.id)).toEqual(['fav'])
  })

  it('filters by status', () => {
    const done = task({ id: 'done', status: 'done' })
    const running = task({ id: 'running', status: 'running' })
    const result = filterTasks([done, running], { ...noFilters, filterStatus: 'running' })
    expect(result.map((t) => t.id)).toEqual(['running'])
  })

  it('matches the search query against prompt and params', () => {
    const byPrompt = task({ id: 'prompt', prompt: 'a sunset over mountains' })
    const byParam = task({
      id: 'param',
      prompt: 'unrelated',
      params: { ...DEFAULT_PARAMS, size: '1024x1024' },
    })
    const miss = task({ id: 'miss', prompt: 'nothing here' })
    const byPromptResult = filterTasks([byPrompt, miss], { ...noFilters, searchQuery: 'sunset' })
    expect(byPromptResult.map((t) => t.id)).toEqual(['prompt'])

    const byParamResult = filterTasks([byParam, miss], { ...noFilters, searchQuery: '1024x1024' })
    expect(byParamResult.map((t) => t.id)).toEqual(['param'])
  })

  it('combines project, status, favorite, and search filters', () => {
    const match = task({
      id: 'match',
      projectId: 'proj-1',
      status: 'done',
      isFavorite: true,
      prompt: 'golden retriever',
    })
    const wrongProject = task({ id: 'wrongProject', projectId: 'proj-2', isFavorite: true, prompt: 'golden retriever' })
    const notFavorite = task({ id: 'notFavorite', projectId: 'proj-1', isFavorite: false, prompt: 'golden retriever' })
    const result = filterTasks([match, wrongProject, notFavorite], {
      currentProjectId: 'proj-1',
      filterStatus: 'done',
      filterFavorite: true,
      searchQuery: 'golden',
    })
    expect(result.map((t) => t.id)).toEqual(['match'])
  })

  it('does not mutate the input array', () => {
    const tasks = [task({ id: 'a', createdAt: 1 }), task({ id: 'b', createdAt: 2 })]
    filterTasks(tasks, noFilters)
    expect(tasks.map((t) => t.id)).toEqual(['a', 'b'])
  })
})
