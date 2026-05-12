import { useMemo, useRef, useState, type ChangeEvent } from 'react'
import { exportTemplatePack, useStore } from '../store'
import { importTemplatePackFile } from '../storeBackend'
import {
  ALL_TEMPLATE_CATEGORIES,
  ALL_TEMPLATE_COLLECTIONS,
  ALL_TEMPLATE_TAGS,
  getTemplateCategories,
  getTemplateCollectionCounts,
  getTemplateTags,
  isApprovedPublicTemplate,
  UNASSIGNED_PROJECT_ID,
} from '../lib/templateUtils'
import { OPEN_PROMPT_LIBRARY_SOURCES, type OpenPromptLibrarySourceId } from '../lib/backendApi'
import { canReviewTemplates } from '../lib/roles'
import Select from './Select'
import OpenPromptImportPreviewModal from './OpenPromptImportPreviewModal'

export default function TemplateFilterBar() {
  const templates = useStore((s) => s.templates)
  const templateSubmissions = useStore((s) => s.templateSubmissions)
  const backendUser = useStore((s) => s.backendUser)
  const openPromptSources = useStore((s) => s.openPromptSources)
  const filters = useStore((s) => s.templateFilters)
  const setTemplateFilters = useStore((s) => s.setTemplateFilters)
  const currentProjectId = useStore((s) => s.currentProjectId)
  const [importSource, setImportSource] = useState<OpenPromptLibrarySourceId>('evolink')
  const [previewOpen, setPreviewOpen] = useState(false)
  const packInputRef = useRef<HTMLInputElement>(null)

  const sourceTemplates = useMemo(() => {
    if (filters.scope === 'review') return templateSubmissions
    if (filters.scope === 'public') {
      return templates.filter((template) => isApprovedPublicTemplate(template))
    }
    if (filters.scope === 'discover') {
      return templates.filter((template) => isApprovedPublicTemplate(template))
    }
    if (currentProjectId === UNASSIGNED_PROJECT_ID) {
      return templates.filter((template) => !template.projectId && !isApprovedPublicTemplate(template))
    }
    if (currentProjectId) {
      return templates.filter((template) => template.projectId === currentProjectId)
    }
    return templates
  }, [currentProjectId, filters.scope, templateSubmissions, templates])
  const categories = useMemo(() => getTemplateCategories(sourceTemplates), [sourceTemplates])
  const tags = useMemo(() => getTemplateTags(sourceTemplates), [sourceTemplates])
  const collectionCounts = useMemo(() => getTemplateCollectionCounts(sourceTemplates), [sourceTemplates])
  const selectedImportStatus = openPromptSources.find((source) => source.id === importSource)
  const templateReviewEnabled = canReviewTemplates(backendUser)
  const collectionOptions = [
    { label: '全部专题', value: ALL_TEMPLATE_COLLECTIONS },
    ...collectionCounts.map((item) => ({ label: item.label, value: item.id })),
  ]
  const reviewSummary = {
    total: templateSubmissions.length,
    highQuality: templateSubmissions.filter((template) => template.qualityScore >= 70).length,
    withSamples: templateSubmissions.filter((template) => template.exampleImages.length || template.coverImageId || template.externalCoverUrl).length,
  }
  const handlePackImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) void importTemplatePackFile(file)
    event.target.value = ''
  }

  return (
    <div className="mt-4 sm:mt-6 mb-3 sm:mb-4 flex flex-col gap-2 sm:gap-3">
      <div className="hidden sm:flex flex-wrap gap-2">
        {templateReviewEnabled && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="relative w-44">
              <Select
                value={importSource}
                onChange={(value) => setImportSource(value as OpenPromptLibrarySourceId)}
                options={OPEN_PROMPT_LIBRARY_SOURCES.map((source) => ({ label: source.label, value: source.id }))}
                className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 transition hover:bg-emerald-100 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
              />
            </div>
            <button
              onClick={() => setPreviewOpen(true)}
              className="rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
            >
              预览导入
            </button>
            {selectedImportStatus && (
              <div className="flex min-w-[14rem] flex-wrap gap-x-2 gap-y-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-xs text-gray-500 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-400">
                <span>已入库 {selectedImportStatus.importedCount}</span>
                <span>上次 +{selectedImportStatus.lastCreated} / 更新 {selectedImportStatus.lastUpdated}</span>
                {selectedImportStatus.lastSyncedAt && <span>{new Date(selectedImportStatus.lastSyncedAt).toLocaleDateString('zh-CN')}</span>}
              </div>
            )}
            <button
              type="button"
              onClick={() => exportTemplatePack(sourceTemplates)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              导出模板包
            </button>
            <button
              type="button"
              onClick={() => packInputRef.current?.click()}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              导入模板包
            </button>
            <input ref={packInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handlePackImport} />
          </div>
        )}
        {!templateReviewEnabled && (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => exportTemplatePack(sourceTemplates)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              导出模板包
            </button>
            <button
              type="button"
              onClick={() => packInputRef.current?.click()}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.06]"
            >
              导入模板包
            </button>
            <input ref={packInputRef} type="file" accept="application/json,.json" className="hidden" onChange={handlePackImport} />
          </div>
        )}
      </div>
      {templateReviewEnabled && filters.scope === 'review' && (
        <div className="flex flex-wrap gap-2 rounded-xl border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200">
          <span>待审核 {reviewSummary.total}</span>
          <span>70+ 高分 {reviewSummary.highQuality}</span>
          <span>带样例 {reviewSummary.withSamples}</span>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:gap-3 sm:flex-row">
        <div className="flex gap-1.5 sm:gap-2 flex-shrink-0 z-20 overflow-x-auto hide-scrollbar">
          <button
            onClick={() => setTemplateFilters({ favoriteOnly: !filters.favoriteOnly })}
            className={`p-2 sm:p-2.5 rounded-xl border transition-all flex-shrink-0 ${
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
          <div className="relative w-28 sm:w-36 flex-shrink-0">
            <Select
              value={filters.collection}
              onChange={(value) => setTemplateFilters({ collection: String(value) })}
              options={collectionOptions}
              className="px-2 sm:px-3 py-2 sm:py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-white/[0.06] text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
            />
          </div>
          <div className="relative w-24 sm:w-32 flex-shrink-0">
            <Select
              value={filters.category}
              onChange={(value) => setTemplateFilters({ category: String(value) })}
              options={[
                { label: '全部分类', value: ALL_TEMPLATE_CATEGORIES },
                ...categories.map((category) => ({ label: category, value: category })),
              ]}
              className="px-2 sm:px-3 py-2 sm:py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-white/[0.06] text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
            />
          </div>
          <div className="relative w-24 sm:w-32 flex-shrink-0">
            <Select
              value={filters.tag}
              onChange={(value) => setTemplateFilters({ tag: String(value) })}
              options={[
                { label: '全部标签', value: ALL_TEMPLATE_TAGS },
                ...tags.map((tag) => ({ label: tag, value: tag })),
              ]}
              className="px-2 sm:px-3 py-2 sm:py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-white/[0.06] text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
            />
          </div>
          <div className="relative w-24 sm:w-32 flex-shrink-0">
            <Select
              value={filters.sort}
              onChange={(value) => setTemplateFilters({ sort: value as any })}
              options={[
                { label: '最近更新', value: 'updated' },
                { label: '热门优先', value: 'popular' },
                { label: '质量优先', value: 'quality' },
                { label: '最近使用', value: 'used' },
              ]}
              className="px-2 sm:px-3 py-2 sm:py-2.5 rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-white/[0.06] text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30 focus:border-blue-400 transition"
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
      <OpenPromptImportPreviewModal
        open={previewOpen}
        source={importSource}
        onClose={() => setPreviewOpen(false)}
      />
    </div>
  )
}
