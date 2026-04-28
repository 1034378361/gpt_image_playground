import { useEffect, useMemo, useState } from 'react'
import { applyTemplate, duplicateTemplate, ensureImageCached, getCachedImage, removeTemplate, setTemplateCover, toggleTemplateFavorite, useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

export default function TemplateDetailModal() {
  const templates = useStore((s) => s.templates)
  const tasks = useStore((s) => s.tasks)
  const selectedTemplateId = useStore((s) => s.selectedTemplateId)
  const setSelectedTemplateId = useStore((s) => s.setSelectedTemplateId)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const setCurrentView = useStore((s) => s.setCurrentView)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const showToast = useStore((s) => s.showToast)

  const template = useMemo(
    () => templates.find((item) => item.id === selectedTemplateId) ?? null,
    [selectedTemplateId, templates],
  )

  const linkedTasks = useMemo(() => {
    if (!template) return []
    return tasks
      .filter((task) => task.templateId === template.id || template.linkedTaskIds.includes(task.id))
      .sort((a, b) => b.createdAt - a.createdAt)
  }, [tasks, template])

  const outputImageIds = useMemo(
    () => [...new Set(linkedTasks.flatMap((task) => task.outputImages || []))],
    [linkedTasks],
  )

  const [imageSrcs, setImageSrcs] = useState<Record<string, string>>({})

  useCloseOnEscape(Boolean(template), () => setSelectedTemplateId(null))

  useEffect(() => {
    if (!template) {
      setImageSrcs({})
      return
    }

    let cancelled = false
    const ids = [...new Set([template.coverImageId, ...outputImageIds].filter((id): id is string => Boolean(id)))]
    const initial: Record<string, string> = {}
    for (const id of ids) {
      const cached = getCachedImage(id)
      if (cached) initial[id] = cached
    }
    setImageSrcs(initial)

    for (const id of ids) {
      if (initial[id]) continue
      ensureImageCached(id).then((url) => {
        if (!cancelled && url) setImageSrcs((prev) => ({ ...prev, [id]: url }))
      })
    }

    return () => {
      cancelled = true
    }
  }, [outputImageIds, template])

  if (!template) return null

  const coverSrc = template.coverImageId ? imageSrcs[template.coverImageId] || '' : ''

  const handleDelete = () => {
    setSelectedTemplateId(null)
    setConfirmDialog({
      title: '删除模板',
      message: '确定要删除这个模板吗？历史生成记录不会被删除。',
      action: () => {
        void removeTemplate(template.id).catch((err) => {
          showToast(err instanceof Error ? err.message : String(err), 'error')
        })
      },
    })
  }

  const runTemplateAction = (action: () => Promise<unknown>) => {
    void action().catch((err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    })
  }

  const openTask = (taskId: string) => {
    setSelectedTemplateId(null)
    setCurrentView('tasks')
    setDetailTaskId(taskId)
  }

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={() => setSelectedTemplateId(null)}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-5xl w-full max-h-[90vh] overflow-hidden flex flex-col md:flex-row z-10 ring-1 ring-black/5 dark:ring-white/10 animate-modal-in"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="md:w-[42%] w-full h-64 md:h-auto bg-gray-100 dark:bg-black/20 relative flex items-center justify-center flex-shrink-0 min-h-[16rem]">
          {coverSrc ? (
            <img
              src={coverSrc}
              data-image-id={template.coverImageId ?? undefined}
              data-template-id={template.id}
              className="max-w-[calc(100%-2rem)] max-h-[calc(100%-2rem)] object-contain cursor-pointer"
              onClick={() => template.coverImageId && setLightboxImageId(template.coverImageId, [template.coverImageId])}
              alt=""
            />
          ) : (
            <div className="flex flex-col items-center gap-2 text-gray-300 dark:text-gray-600">
              <svg className="w-12 h-12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428 12 22.856l-7.428-7.428a5.25 5.25 0 0 1 7.428-7.428 5.25 5.25 0 0 1 7.428 7.428Z" />
              </svg>
              <span className="text-sm">暂无封面</span>
            </div>
          )}
        </div>

        <div className="flex-1 p-5 overflow-y-auto">
          <button
            onClick={() => setSelectedTemplateId(null)}
            className="absolute top-3 right-3 p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06] transition text-gray-400 z-10"
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>

          <div className="pr-8">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-lg font-bold text-gray-800 dark:text-gray-100">{template.title}</h2>
              {template.category && (
                <span className="rounded-full bg-blue-50 dark:bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400">
                  {template.category}
                </span>
              )}
            </div>
            {template.description && (
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed mb-4">{template.description}</p>
            )}

            <div className="flex flex-wrap gap-1.5 mb-4">
              {template.tags.map((tag) => (
                <span key={tag} className="rounded-full bg-gray-100 dark:bg-white/[0.06] px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                  {tag}
                </span>
              ))}
            </div>

            <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">Prompt</h3>
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap mb-4">
              {template.prompt || '(无提示词)'}
            </p>

            {template.negativePrompt && (
              <>
                <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">Negative Prompt</h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed whitespace-pre-wrap mb-4">
                  {template.negativePrompt}
                </p>
              </>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs mb-4">
              <Info label="API" value={template.apiMode} />
              <Info label="模型" value={template.model} />
              <Info label="尺寸" value={template.params.size} />
              <Info label="质量" value={template.params.quality} />
              <Info label="格式" value={template.params.output_format} />
              <Info label="数量" value={String(template.params.n)} />
              <Info label="审核" value={template.params.moderation} />
              <Info label="版本" value={String(template.version)} />
            </div>

            {outputImageIds.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">关联产物</h3>
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                  {outputImageIds.map((imageId) => {
                    const src = imageSrcs[imageId] || ''
                    return (
                      <div key={imageId} className="relative group aspect-square rounded-lg overflow-hidden bg-gray-100 dark:bg-black/20 border border-gray-200 dark:border-white/[0.08]">
                        {src && (
                          <img
                            src={src}
                            data-image-id={imageId}
                            data-template-id={template.id}
                            className="w-full h-full object-cover cursor-pointer"
                            onClick={() => setLightboxImageId(imageId, outputImageIds)}
                            alt=""
                          />
                        )}
                        <button
                          onClick={() => runTemplateAction(() => setTemplateCover(template.id, imageId))}
                          className="absolute inset-x-1 bottom-1 rounded bg-black/60 px-1 py-1 text-[10px] text-white opacity-0 group-hover:opacity-100 transition"
                        >
                          设为封面
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {linkedTasks.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">关联任务</h3>
                <div className="space-y-2">
                  {linkedTasks.slice(0, 6).map((task) => (
                    <button
                      key={task.id}
                      onClick={() => openTask(task.id)}
                      className="w-full text-left rounded-lg bg-gray-50 dark:bg-white/[0.03] px-3 py-2 hover:bg-gray-100 dark:hover:bg-white/[0.06] transition"
                    >
                      <span className="block text-xs text-gray-400 dark:text-gray-500">
                        {new Date(task.createdAt).toLocaleString('zh-CN')} · {task.status}
                      </span>
                      <span className="mt-1 block truncate text-sm text-gray-700 dark:text-gray-300">{task.prompt}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="grid grid-cols-4 sm:flex gap-2 pt-4 border-t border-gray-100 dark:border-white/[0.08]">
            <button
              onClick={() => applyTemplate(template)}
              className="col-span-2 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 hover:bg-blue-100 dark:hover:bg-blue-500/20 transition text-sm font-medium whitespace-nowrap"
            >
              套用模板
            </button>
            <button
              onClick={() => setTemplateEditor({ mode: 'edit', templateId: template.id })}
              className="col-span-2 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-green-50 dark:bg-green-500/10 text-green-600 dark:text-green-400 hover:bg-green-100 dark:hover:bg-green-500/20 transition text-sm font-medium whitespace-nowrap"
            >
              编辑
            </button>
            <button
              onClick={() => runTemplateAction(() => duplicateTemplate(template.id))}
              className="col-span-2 sm:flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-xl bg-purple-50 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 hover:bg-purple-100 dark:hover:bg-purple-500/20 transition text-sm font-medium whitespace-nowrap"
            >
              复制
            </button>
            <button
              onClick={handleDelete}
              className="col-span-1 sm:flex-none sm:w-11 flex items-center justify-center rounded-xl bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-500/20 transition"
              title="删除模板"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16" />
              </svg>
            </button>
            <button
              onClick={() => runTemplateAction(() => toggleTemplateFavorite(template.id))}
              className={`col-span-1 sm:flex-none sm:w-11 flex items-center justify-center rounded-xl transition ${
                template.isFavorite
                  ? 'bg-yellow-50 text-yellow-500 hover:bg-yellow-100 dark:bg-yellow-500/10 dark:hover:bg-yellow-500/20'
                  : 'bg-gray-50 text-gray-400 hover:bg-yellow-50 hover:text-yellow-500 dark:bg-white/[0.04] dark:hover:bg-yellow-500/10'
              }`}
              title={template.isFavorite ? '取消收藏' : '收藏模板'}
            >
              <svg className="w-5 h-5" fill={template.isFavorite ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 0 0 .95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 0 0-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 0 0-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 0 0-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 0 0 .951-.69z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-gray-50 dark:bg-white/[0.03] rounded-lg px-3 py-2 min-w-0">
      <span className="text-gray-400 dark:text-gray-500">{label}</span>
      <br />
      <span className="font-medium text-gray-700 dark:text-gray-200 break-all">{value || '-'}</span>
    </div>
  )
}
