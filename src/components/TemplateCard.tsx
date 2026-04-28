import { useEffect, useState } from 'react'
import type { PromptTemplate } from '../types'
import { applyTemplate, duplicateTemplate, getCachedImage, removeTemplate, toggleTemplateFavorite, useStore, ensureImageCached } from '../store'

interface Props {
  template: PromptTemplate
}

export default function TemplateCard({ template }: Props) {
  const [coverSrc, setCoverSrc] = useState('')
  const setSelectedTemplateId = useStore((s) => s.setSelectedTemplateId)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const taskCount = useStore((s) =>
    s.tasks.filter((task) => task.templateId === template.id || template.linkedTaskIds.includes(task.id)).length,
  )

  useEffect(() => {
    let cancelled = false
    setCoverSrc('')
    if (!template.coverImageId) return

    const cached = getCachedImage(template.coverImageId)
    if (cached) {
      setCoverSrc(cached)
      return
    }

    ensureImageCached(template.coverImageId).then((url) => {
      if (!cancelled && url) setCoverSrc(url)
    })

    return () => {
      cancelled = true
    }
  }, [template.coverImageId])

  const handleDelete = () => {
    setConfirmDialog({
      title: '删除模板',
      message: '确定要删除这个模板吗？历史生成记录不会被删除。',
      action: () => removeTemplate(template.id),
    })
  }

  return (
    <div
      className="group bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-white/[0.08] overflow-hidden hover:shadow-lg hover:border-gray-300 dark:hover:border-white/[0.18] dark:hover:bg-gray-800/80 transition cursor-pointer"
      onClick={() => setSelectedTemplateId(template.id)}
    >
      <div className="h-40 bg-gray-100 dark:bg-black/20 relative flex items-center justify-center overflow-hidden">
        {coverSrc ? (
          <img
            src={coverSrc}
            data-image-id={template.coverImageId ?? undefined}
            data-template-id={template.id}
            className="w-full h-full object-cover"
            loading="lazy"
            alt=""
          />
        ) : (
          <div className="flex flex-col items-center gap-2 text-gray-300 dark:text-gray-600">
            <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428 12 22.856l-7.428-7.428a5.25 5.25 0 0 1 7.428-7.428 5.25 5.25 0 0 1 7.428 7.428Z" />
            </svg>
            <span className="text-xs">暂无封面</span>
          </div>
        )}
        <div className="absolute left-2 top-2 flex items-center gap-1">
          {template.category && (
            <span className="rounded-full bg-black/50 px-2 py-0.5 text-xs text-white backdrop-blur-sm">
              {template.category}
            </span>
          )}
          <span className="rounded-full bg-black/50 px-2 py-0.5 text-xs text-white/90 backdrop-blur-sm">
            {taskCount} 次
          </span>
        </div>
      </div>

      <div className="p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-800 dark:text-gray-100 truncate">{template.title}</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 leading-relaxed line-clamp-2">
              {template.description || template.prompt || '(无提示词)'}
            </p>
          </div>
          <button
            onClick={(e) => {
              e.stopPropagation()
              toggleTemplateFavorite(template.id)
            }}
            className={`p-1.5 rounded-md transition ${
              template.isFavorite
                ? 'text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'
                : 'text-gray-400 hover:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'
            }`}
            title={template.isFavorite ? '取消收藏模板' : '收藏模板'}
          >
            <svg className="w-4 h-4" fill={template.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
            </svg>
          </button>
        </div>

        {template.tags.length > 0 && (
          <div className="mt-3 flex gap-1.5 overflow-x-auto hide-scrollbar mask-edge-r">
            {template.tags.slice(0, 5).map((tag) => (
              <span key={tag} className="flex-shrink-0 rounded-full bg-blue-50 dark:bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400">
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="mt-3 flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={() => applyTemplate(template)}
            className="p-1.5 rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950/30 transition"
            title="套用模板"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0-5 5m5-5H6" />
            </svg>
          </button>
          <button
            onClick={() => setTemplateEditor({ mode: 'edit', templateId: template.id })}
            className="p-1.5 rounded-md text-gray-400 hover:text-green-500 hover:bg-green-50 dark:hover:bg-green-950/30 transition"
            title="编辑模板"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.414-9.414a2 2 0 1 1 2.828 2.828L11.828 15H9v-2.828z" />
            </svg>
          </button>
          <button
            onClick={() => duplicateTemplate(template.id)}
            className="p-1.5 rounded-md text-gray-400 hover:text-purple-500 hover:bg-purple-50 dark:hover:bg-purple-950/30 transition"
            title="复制模板"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          </button>
          <button
            onClick={handleDelete}
            className="p-1.5 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 transition"
            title="删除模板"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  )
}
