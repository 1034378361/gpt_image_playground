import { useMemo } from 'react'
import { useStore } from '../store'
import { filterTemplates, isApprovedPublicTemplate, UNASSIGNED_PROJECT_ID } from '../lib/templateUtils'
import TemplateCard from './TemplateCard'

export default function TemplateGrid() {
  const templates = useStore((s) => s.templates)
  const templateSubmissions = useStore((s) => s.templateSubmissions)
  const backendUser = useStore((s) => s.backendUser)
  const filters = useStore((s) => s.templateFilters)
  const projects = useStore((s) => s.projects)
  const currentProjectId = useStore((s) => s.currentProjectId)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)

  const scopedTemplates = useMemo(() => {
    if (filters.scope === 'review') return templateSubmissions
    if (filters.scope === 'public') {
      return templates.filter((template) => isApprovedPublicTemplate(template))
    }
    if (filters.scope === 'discover') {
      return [...templates]
        .filter((template) => isApprovedPublicTemplate(template) && template.userId !== backendUser?.id)
        .sort((a, b) => (b.qualityScore ?? 0) - (a.qualityScore ?? 0) || (b.successCount ?? 0) - (a.successCount ?? 0))
    }
    return templates
  }, [filters.scope, templateSubmissions, templates, backendUser?.id])

  const filteredTemplates = useMemo(
    () =>
      filterTemplates(
        scopedTemplates.filter((template) => {
          if (currentProjectId === UNASSIGNED_PROJECT_ID) {
            return !template.projectId && !isApprovedPublicTemplate(template)
          }
          if (currentProjectId) {
            return template.projectId === currentProjectId
          }
          return true
        }),
        filters,
      ),
    [currentProjectId, scopedTemplates, filters],
  )
  const currentProject = useMemo(
    () => projects.find((project) => project.id === currentProjectId) ?? null,
    [currentProjectId, projects],
  )
  const isGroupedProjectView = Boolean(
    filters.scope === 'public' || (currentProject && currentProjectId && currentProjectId !== UNASSIGNED_PROJECT_ID && filters.scope !== 'review'),
  )
  const templateSections = useMemo(() => {
    if (filters.scope === 'public') {
      return [
        {
          id: 'public',
          title: '公共模板库',
          description: '这里是全局公共模板。套用不入项目，复制或改写后才会成为项目私有模板。',
          templates: filteredTemplates,
        },
      ]
    }

    if (!isGroupedProjectView || !currentProjectId || currentProjectId === UNASSIGNED_PROJECT_ID) {
      return [{ id: 'all', title: '', description: '', templates: filteredTemplates }]
    }

    return [
      {
        id: 'project',
        title: `${currentProject?.name || '当前项目'}模板`,
        description: '这是当前项目自己的模板资产。',
        templates: filteredTemplates,
      },
    ].filter((section) => section.templates.length > 0)
  }, [currentProject?.name, currentProjectId, filteredTemplates, filters.scope, isGroupedProjectView])

  if (!filteredTemplates.length) {
    const hasFilter = Boolean(
      filters.query.trim()
        || filters.favoriteOnly
        || filters.category !== '__all__'
        || filters.tag !== '__all__'
        || filters.collection !== '__all__',
    )
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        {hasFilter ? (
          <p className="text-sm">没有找到匹配的模板</p>
        ) : filters.scope === 'review' ? (
          <p className="text-sm">当前没有待审核模板</p>
        ) : isGroupedProjectView ? (
          <>
            <svg className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7Z" />
            </svg>
            <p className="text-sm">
              {filters.scope === 'public'
                ? '当前没有可显示的公共模板'
                : `${currentProject?.name || '当前项目'} 里还没有可显示的模板`}
            </p>
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
              {filters.scope === 'public'
                ? '管理员导入并审批后，这里会显示全局公共模板。'
                : '新建私有模板，或点击上方“公共模板”浏览全局模板库。'}
            </p>
            {filters.scope !== 'public' && (
              <button
                onClick={() => setTemplateEditor({ mode: 'create' })}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
                </svg>
                新建项目模板
              </button>
            )}
          </>
        ) : (
          <>
            <svg className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19.428 15.428 12 22.856l-7.428-7.428a5.25 5.25 0 0 1 7.428-7.428 5.25 5.25 0 0 1 7.428 7.428Z" />
            </svg>
            <p className="text-sm">创建第一个提示词模板</p>
            {filters.scope !== 'public' && (
              <button
                onClick={() => setTemplateEditor({ mode: 'create' })}
                className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
                </svg>
                新建模板
              </button>
            )}
          </>
        )}
      </div>
    )
  }

  if (templateSections.length > 1 || templateSections[0]?.title) {
    return (
      <div className="space-y-8 pb-10">
        {templateSections.map((section) => (
          <section key={section.id}>
            {section.title && (
              <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold text-gray-800 dark:text-gray-100">{section.title}</h3>
                    <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                      {section.templates.length}
                    </span>
                  </div>
                  {section.description && (
                    <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{section.description}</p>
                  )}
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {section.templates.map((template) => (
                <TemplateCard key={template.id} template={template} />
              ))}
            </div>
          </section>
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-10">
      {filteredTemplates.map((template) => (
        <TemplateCard key={template.id} template={template} />
      ))}
    </div>
  )
}
