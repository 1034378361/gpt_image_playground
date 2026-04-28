import { useMemo } from 'react'
import { useStore } from '../store'
import { ALL_TEMPLATE_CATEGORIES, ALL_TEMPLATE_TAGS, getTemplateCategories, getTemplateTags } from '../lib/templateUtils'
import Select from './Select'

export default function TemplateFilterBar() {
  const templates = useStore((s) => s.templates)
  const filters = useStore((s) => s.templateFilters)
  const setTemplateFilters = useStore((s) => s.setTemplateFilters)

  const categories = useMemo(() => getTemplateCategories(templates), [templates])
  const tags = useMemo(() => getTemplateTags(templates), [templates])

  return (
    <div className="mt-6 mb-4 flex flex-col gap-3 sm:flex-row">
      <div className="flex gap-2 flex-shrink-0 z-20">
        <button
          onClick={() => setTemplateFilters({ favoriteOnly: !filters.favoriteOnly })}
          className={`p-2.5 rounded-xl border transition-all ${
            filters.favoriteOnly
              ? 'border-yellow-400 bg-yellow-50 dark:bg-yellow-500/10 text-yellow-500'
              : 'border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06]'
          }`}
          title={filters.favoriteOnly ? '取消只看收藏模板' : '只看收藏模板'}
        >
          <svg className="w-5 h-5" fill={filters.favoriteOnly ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
          </svg>
        </button>
        <div className="relative w-32">
          <Select
            value={filters.category}
            onChange={(value) => setTemplateFilters({ category: String(value) })}
            options={[
              { label: '全部分类', value: ALL_TEMPLATE_CATEGORIES },
              ...categories.map((category) => ({ label: category, value: category })),
            ]}
            className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-white/[0.06] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
          />
        </div>
        <div className="relative w-32">
          <Select
            value={filters.tag}
            onChange={(value) => setTemplateFilters({ tag: String(value) })}
            options={[
              { label: '全部标签', value: ALL_TEMPLATE_TAGS },
              ...tags.map((tag) => ({ label: tag, value: tag })),
            ]}
            className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-white/[0.06] text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
          />
        </div>
      </div>
      <div className="relative flex-1 z-10">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 dark:text-gray-500"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          value={filters.query}
          onChange={(e) => setTemplateFilters({ query: e.target.value })}
          type="text"
          placeholder="搜索模板标题、提示词、标签..."
          className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
        />
      </div>
    </div>
  )
}
