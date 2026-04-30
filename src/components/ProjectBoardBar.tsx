import { useMemo } from 'react'
import { useStore } from '../store'
import { isApprovedPublicTemplate, UNASSIGNED_PROJECT_ID } from '../lib/templateUtils'
import { canReviewTemplates } from '../lib/roles'

export default function ProjectBoardBar() {
  const projects = useStore((s) => s.projects)
  const currentProjectId = useStore((s) => s.currentProjectId)
  const setCurrentProjectId = useStore((s) => s.setCurrentProjectId)
  const currentView = useStore((s) => s.currentView)
  const setShowProjectManager = useStore((s) => s.setShowProjectManager)
  const backendUser = useStore((s) => s.backendUser)
  const templateFilters = useStore((s) => s.templateFilters)
  const setTemplateFilters = useStore((s) => s.setTemplateFilters)
  const templateSubmissions = useStore((s) => s.templateSubmissions)
  const tasks = useStore((s) => s.tasks)
  const templates = useStore((s) => s.templates)

  const visibleProjects = useMemo(
    () => projects.filter((project) => !project.isArchived || currentProjectId === project.id),
    [currentProjectId, projects],
  )
  const currentProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId) ?? null,
    [currentProjectId, projects],
  )
  const publicTemplateCount = useMemo(
    () => templates.filter((template) => isApprovedPublicTemplate(template)).length,
    [templates],
  )
  const unassignedCount = useMemo(
    () =>
      currentView === 'tasks'
        ? tasks.filter((task) => !task.projectId).length
        : templates.filter((template) => !template.projectId && !isApprovedPublicTemplate(template)).length,
    [currentView, tasks, templates],
  )
  const countForProject = (projectId: string) =>
    currentView === 'tasks'
      ? tasks.filter((task) => task.projectId === projectId).length
      : templates.filter((template) => template.projectId === projectId).length
  const allLabel = currentView === 'templates' ? '全部模板' : '全部'
  const publicLabel = currentView === 'templates' ? '公共模板库' : '公共'
  const unassignedLabel = currentView === 'templates' ? '未归类模板' : '未归类'
  const templateSpaceMessage =
    currentView !== 'templates'
      ? ''
      : templateFilters.scope === 'review'
      ? '当前为审核视图，只显示待审核投稿模板。'
      : templateFilters.scope === 'public'
      ? '当前正在浏览公共模板库。这里的模板是全局共享资产，套用不会自动放入项目；复制或改写后，才会进入你的私有空间或当前项目。'
      : currentProjectId === UNASSIGNED_PROJECT_ID
      ? '当前正在浏览未归类模板。这里存放尚未归属到具体项目的私有模板。'
      : currentProject
      ? `当前项目模板 ${countForProject(currentProject.id)} 个。这里只显示该项目自己的私有模板；公共模板请从上方“公共模板库”单独进入。`
      : '当前正在浏览全部模板。这是总览视图，会同时汇总公共模板、项目模板和未归类模板。'

  const openPublicTemplates = () => {
    setCurrentProjectId(null)
    setTemplateFilters({ scope: 'public' })
  }

  const openReviewQueue = () => {
    setCurrentProjectId(null)
    setTemplateFilters({ scope: 'review' })
  }

  const openProjectTemplates = (projectId: string | null) => {
    setCurrentProjectId(projectId)
    if (currentView === 'templates' && templateFilters.scope !== 'all') {
      setTemplateFilters({ scope: 'all' })
    }
  }

  return (
    <section className="mt-4 border-b border-gray-200/80 pb-4 dark:border-white/[0.08]">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
            {currentView === 'templates' ? '浏览模板空间' : '浏览任务空间'}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => openProjectTemplates(null)}
              className={`rounded-xl px-3 py-2 text-xs transition ${
                currentProjectId === null && (currentView !== 'templates' || templateFilters.scope === 'all')
                  ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                  : 'border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.06]'
              }`}
            >
              {allLabel}
            </button>
            {currentView === 'templates' && (
              <button
                type="button"
                onClick={openPublicTemplates}
                className={`rounded-xl border px-3 py-2 text-xs transition ${
                  templateFilters.scope === 'public' && currentProjectId === null
                    ? 'border-emerald-500 bg-emerald-500 text-white dark:border-emerald-400 dark:bg-emerald-400 dark:text-gray-950'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20'
                }`}
              >
                {publicLabel} {publicTemplateCount}
              </button>
            )}
            <button
              type="button"
              onClick={() => openProjectTemplates(UNASSIGNED_PROJECT_ID)}
              className={`rounded-xl px-3 py-2 text-xs transition ${
                currentProjectId === UNASSIGNED_PROJECT_ID && (currentView !== 'templates' || templateFilters.scope === 'all')
                  ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900'
                  : 'border border-gray-200 bg-white text-gray-500 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.06]'
              }`}
            >
              {unassignedLabel}
              <span className="ml-1 opacity-70">{unassignedCount}</span>
            </button>
            {visibleProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => openProjectTemplates(project.id)}
                className={`inline-flex items-center gap-2 rounded-xl px-3 py-2 text-xs transition ${
                  currentProjectId === project.id && (currentView !== 'templates' || templateFilters.scope === 'all')
                    ? 'bg-gray-900 text-white shadow-sm dark:bg-white dark:text-gray-900'
                    : 'border border-gray-200 bg-white text-gray-600 hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]'
                }`}
              >
                <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: project.color }} />
                <span className="max-w-[10rem] truncate">{project.name}</span>
                <span className="opacity-70">{countForProject(project.id)}</span>
              </button>
            ))}
            {currentView === 'templates' && canReviewTemplates(backendUser) && (
              <button
                type="button"
                onClick={openReviewQueue}
                className={`rounded-xl border px-3 py-2 text-xs transition ${
                  templateFilters.scope === 'review' && currentProjectId === null
                    ? 'border-amber-500 bg-amber-500 text-white dark:border-amber-400 dark:bg-amber-400 dark:text-gray-950'
                    : 'border-amber-200 bg-amber-50 text-amber-700 hover:bg-amber-100 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20'
                }`}
              >
                审核队列 {templateSubmissions.length}
              </button>
            )}
          </div>
        </div>

        <div className="lg:w-auto lg:min-w-[9rem]">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
            管理
          </div>
          <button
            type="button"
            onClick={() => setShowProjectManager(true)}
            className="inline-flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M4 12h10m-10 5h16" />
            </svg>
            项目管理
          </button>
        </div>
      </div>
      {currentView === 'templates' && templateSpaceMessage && (
        <div
          className={`mt-3 rounded-xl px-3 py-2 text-xs ${
            templateFilters.scope === 'review'
              ? 'border border-amber-200/70 bg-amber-50/80 text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200'
              : templateFilters.scope === 'public'
              ? 'border border-emerald-200/70 bg-emerald-50/80 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200'
              : 'border border-gray-200/70 bg-gray-50/80 text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400'
          }`}
        >
          {templateSpaceMessage}
        </div>
      )}
    </section>
  )
}
