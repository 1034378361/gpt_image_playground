import { useMemo } from 'react'
import { useStore } from '../store'
import { filterTemplates } from '../lib/templateUtils'
import TemplateCard from './TemplateCard'

export default function TemplateGrid() {
  const templates = useStore((s) => s.templates)
  const filters = useStore((s) => s.templateFilters)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)

  const filteredTemplates = useMemo(
    () => filterTemplates(templates, filters),
    [templates, filters],
  )

  if (!filteredTemplates.length) {
    const hasFilter = Boolean(filters.query.trim() || filters.favoriteOnly || filters.category !== '__all__' || filters.tag !== '__all__')
    return (
      <div className="text-center py-20 text-gray-400 dark:text-gray-500">
        {hasFilter ? (
          <p className="text-sm">没有找到匹配的模板</p>
        ) : (
          <>
            <svg className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19.428 15.428 12 22.856l-7.428-7.428a5.25 5.25 0 0 1 7.428-7.428 5.25 5.25 0 0 1 7.428 7.428Z" />
            </svg>
            <p className="text-sm">创建第一个提示词模板</p>
            <button
              onClick={() => setTemplateEditor({ mode: 'create' })}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
              </svg>
              新建模板
            </button>
          </>
        )}
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
