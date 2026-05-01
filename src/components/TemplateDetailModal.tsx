import { useEffect, useMemo, useState } from 'react'
import type { PromptTemplate, TemplateSample, TemplateVersion } from '../types'
import { applyTemplate, duplicateTemplate, ensureImageCached, getCachedImage, removeTemplate, setTemplateCover, toggleTemplateFavorite, useStore } from '../store'
import { approveTemplate, rejectTemplate, submitTemplateForReview } from '../storeBackend'
import { listSimilarTemplates, listTemplateSamples, listTemplateVersions, rateTemplate, restoreTemplateVersion } from '../lib/backendApi'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

export default function TemplateDetailModal() {
  const templates = useStore((s) => s.templates)
  const templateSubmissions = useStore((s) => s.templateSubmissions)
  const tasks = useStore((s) => s.tasks)
  const settings = useStore((s) => s.settings)
  const channels = useStore((s) => s.channels)
  const selectedTemplateId = useStore((s) => s.selectedTemplateId)
  const setSelectedTemplateId = useStore((s) => s.setSelectedTemplateId)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const setCurrentView = useStore((s) => s.setCurrentView)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const showToast = useStore((s) => s.showToast)
  const backendUser = useStore((s) => s.backendUser)
  const setTemplates = useStore((s) => s.setTemplates)

  const [samples, setSamples] = useState<TemplateSample[]>([])
  const [versions, setVersions] = useState<TemplateVersion[]>([])
  const [similarTemplates, setSimilarTemplates] = useState<PromptTemplate[]>([])
  const [ratingBusy, setRatingBusy] = useState(false)

  const template = useMemo(
    () =>
      templateSubmissions.find((item) => item.id === selectedTemplateId) ??
      templates.find((item) => item.id === selectedTemplateId) ??
      null,
    [selectedTemplateId, templateSubmissions, templates],
  )

  const channelName = useMemo(() => {
    const channelId = template?.recommendedChannelId || template?.channelId
    if (!channelId) return ''
    return channels.find((channel) => channel.id === channelId)?.name ?? channelId
  }, [channels, template?.channelId, template?.recommendedChannelId])

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
  const sampleImageIds = useMemo(
    () => [...new Set(samples.map((sample) => sample.imageId))],
    [samples],
  )

  const [imageSrcs, setImageSrcs] = useState<Record<string, string>>({})

  useCloseOnEscape(Boolean(template), () => setSelectedTemplateId(null))

  useEffect(() => {
    if (!template) {
      setSamples([])
      setVersions([])
      setSimilarTemplates([])
      return
    }
    let cancelled = false
    void Promise.all([
      listTemplateSamples(settings, template.id, 36).catch(() => []),
      listTemplateVersions(settings, template.id).catch(() => []),
      listSimilarTemplates(settings, { templateId: template.id, limit: 6 }).catch(() => []),
    ]).then(([nextSamples, nextVersions, nextSimilar]) => {
      if (cancelled) return
      setSamples(nextSamples)
      setVersions(nextVersions)
      setSimilarTemplates(nextSimilar)
    })
    return () => {
      cancelled = true
    }
  }, [settings, template?.id])

  useEffect(() => {
    if (!template) {
      setImageSrcs({})
      return
    }

    let cancelled = false
    const ids = [...new Set([template.coverImageId, ...outputImageIds, ...sampleImageIds].filter((id): id is string => Boolean(id)))]
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
  }, [outputImageIds, sampleImageIds, template])

  if (!template) return null

  const isOwner = backendUser?.id === template.userId
  const isAdmin = backendUser?.role === 'admin'
  const canFavorite = Boolean(isOwner || isAdmin)
  const canManageDirectly = Boolean(isAdmin || (isOwner && template.submissionStatus !== 'submitted' && template.visibility !== 'public' && template.submissionStatus !== 'approved'))
  const canAdapt = Boolean(template.visibility === 'public' && !isAdmin)
  const canEdit = canManageDirectly || canAdapt
  const canDelete = canManageDirectly
  const canSubmit = Boolean(isOwner && !isAdmin && template.visibility !== 'public' && template.submissionStatus !== 'submitted' && template.submissionStatus !== 'approved')
  const canReview = Boolean(isAdmin && template.submissionStatus === 'submitted')

  const coverSrc = template.coverImageId
    ? imageSrcs[template.coverImageId] || template.externalCoverUrl || template.exampleImages[0] || ''
    : template.externalCoverUrl || template.exampleImages[0] || ''
  const exampleImages = [...new Set([coverSrc, ...(template.exampleImages ?? [])].filter(Boolean))]
  const useCount = Math.max(template.usageCount ?? 0, linkedTasks.length)

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

  const handleRate = (score: number) => {
    setRatingBusy(true)
    void rateTemplate(settings, template.id, score)
      .then((updated) => {
        setTemplates(templates.map((item) => (item.id === template.id ? updated : item)))
        showToast('模板评分已更新', 'success')
      })
      .catch((err) => showToast(err instanceof Error ? err.message : String(err), 'error'))
      .finally(() => setRatingBusy(false))
  }

  const handleRestoreVersion = (version: TemplateVersion) => {
    setConfirmDialog({
      title: `恢复到 v${version.version}`,
      message: '恢复后会生成一个新的当前版本，原版本记录会保留。',
      confirmText: '恢复版本',
      action: () => {
        void restoreTemplateVersion(settings, template.id, version.id)
          .then((updated) => {
            setTemplates(templates.map((item) => (item.id === template.id ? updated : item)))
            return listTemplateVersions(settings, template.id)
          })
          .then(setVersions)
          .then(() => showToast('模板版本已恢复', 'success'))
          .catch((err) => showToast(err instanceof Error ? err.message : String(err), 'error'))
      },
    })
  }

  const openTask = (taskId: string) => {
    setSelectedTemplateId(null)
    setCurrentView('tasks')
    setDetailTaskId(taskId)
  }

  const openSimilarTemplate = (item: PromptTemplate) => {
    setSelectedTemplateId(item.id)
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
              onClick={() => {
                if (template.coverImageId) {
                  setLightboxImageId(template.coverImageId, [template.coverImageId])
                } else if (template.externalCoverUrl) {
                  window.open(template.externalCoverUrl, '_blank', 'noopener,noreferrer')
                }
              }}
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
              <span className={`rounded-full px-2 py-0.5 text-xs ${
                template.visibility === 'public'
                  ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300'
                  : template.submissionStatus === 'submitted'
                  ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300'
                  : template.submissionStatus === 'rejected'
                  ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-300'
                  : 'bg-gray-100 text-gray-600 dark:bg-white/[0.06] dark:text-gray-300'
              }`}>
                {template.visibility === 'public'
                  ? '公共模板'
                  : template.submissionStatus === 'submitted'
                  ? '待审核'
                  : template.submissionStatus === 'rejected'
                  ? '已驳回'
                  : '私有模板'}
              </span>
            </div>
            {template.rejectionReason && (
              <p className="mb-4 text-sm text-rose-500 dark:text-rose-300">驳回原因：{template.rejectionReason}</p>
            )}
            {template.description && (
              <p className="text-sm text-gray-500 dark:text-gray-400 leading-relaxed mb-4">{template.description}</p>
            )}

            {(template.sourceName || template.sourceAuthor || template.licenseName) && (
              <div className="mb-4 rounded-xl border border-gray-200/70 bg-gray-50/80 px-3 py-2 text-xs text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400">
                <span>来源：{template.sourceUrl ? (
                  <a
                    href={template.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:underline dark:text-blue-300"
                  >
                    {template.sourceName || template.sourceUrl}
                  </a>
                ) : (template.sourceName || '-')}</span>
                {template.sourceAuthor && <span> · 作者：{template.sourceAuthor}</span>}
                {template.licenseName && <span> · 许可：{template.licenseName}</span>}
              </div>
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
              <Info label="渠道" value={channelName} />
              <Info label="API" value={template.recommendedApiMode || template.apiMode} />
              <Info label="模型" value={template.recommendedModel || template.model} />
              <Info label="尺寸" value={template.params.size} />
              <Info label="质量" value={template.params.quality} />
              <Info label="格式" value={template.params.output_format} />
              <Info label="数量" value={String(template.params.n)} />
              <Info label="审核" value={template.params.moderation} />
              <Info label="版本" value={String(template.version)} />
              <Info label="使用" value={String(useCount)} />
              <Info label="收藏" value={String(template.favoriteCount ?? Number(template.isFavorite))} />
              <Info label="评分" value={String(Math.round(template.qualityScore ?? 0))} />
              <Info label="成功" value={String(template.successCount ?? 0)} />
              <Info label="失败" value={String(template.failureCount ?? 0)} />
              <Info label="用户评分" value={template.ratingCount ? `${template.averageRating.toFixed(1)} / 5` : '-'} />
              <Info label="样例" value={String(samples.length + outputImageIds.length)} />
            </div>

            <div className="mb-4 rounded-xl border border-gray-200/70 bg-gray-50/80 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.03]">
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">模板效果评分</span>
                {template.ratingCount > 0 && (
                  <span className="text-xs text-gray-400 dark:text-gray-500">{template.ratingCount} 人评分</span>
                )}
              </div>
              <div className="flex gap-1">
                {[1, 2, 3, 4, 5].map((score) => (
                  <button
                    key={score}
                    type="button"
                    disabled={ratingBusy}
                    onClick={() => handleRate(score)}
                    className={`rounded-lg px-2 py-1 text-sm transition disabled:opacity-50 ${
                      template.averageRating >= score
                        ? 'bg-yellow-50 text-yellow-500 dark:bg-yellow-500/10'
                        : 'bg-white text-gray-400 hover:bg-yellow-50 hover:text-yellow-500 dark:bg-white/[0.04]'
                    }`}
                    title={`${score} 分`}
                  >
                    ★
                  </button>
                ))}
              </div>
            </div>

            {exampleImages.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">示例图</h3>
                <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
                  {exampleImages.slice(0, 12).map((src) => (
                    <button
                      key={src}
                      type="button"
                      onClick={() => window.open(src, '_blank', 'noopener,noreferrer')}
                      className="aspect-square overflow-hidden rounded-lg border border-gray-200 bg-gray-100 transition hover:opacity-90 dark:border-white/[0.08] dark:bg-black/20"
                    >
                      <img src={src} className="h-full w-full object-cover" alt="" loading="lazy" />
                    </button>
                  ))}
                </div>
              </div>
            )}

            {samples.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">效果样例墙</h3>
                <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                  {samples.slice(0, 16).map((sample) => {
                    const src = imageSrcs[sample.imageId] || ''
                    return (
                      <button
                        key={sample.imageId}
                        type="button"
                        onClick={() => setLightboxImageId(sample.imageId, sampleImageIds)}
                        className="group relative aspect-square overflow-hidden rounded-lg border border-gray-200 bg-gray-100 text-left transition hover:opacity-90 dark:border-white/[0.08] dark:bg-black/20"
                        title={sample.prompt || sample.model || '样例'}
                      >
                        {src && (
                          <img
                            src={src}
                            data-image-id={sample.imageId}
                            data-template-id={template.id}
                            className="h-full w-full object-cover"
                            alt=""
                            loading="lazy"
                          />
                        )}
                        <span className="absolute inset-x-1 bottom-1 truncate rounded bg-black/55 px-1.5 py-0.5 text-[10px] text-white opacity-0 backdrop-blur-sm transition group-hover:opacity-100">
                          {sample.model || sample.params.size}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </div>
            )}

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

            {similarTemplates.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">相似模板</h3>
                <div className="grid gap-2 sm:grid-cols-2">
                  {similarTemplates.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => openSimilarTemplate(item)}
                      className="rounded-lg bg-gray-50 px-3 py-2 text-left transition hover:bg-gray-100 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]"
                    >
                      <span className="block truncate text-sm font-medium text-gray-700 dark:text-gray-200">{item.title}</span>
                      <span className="mt-1 block truncate text-xs text-gray-400 dark:text-gray-500">
                        {item.category || '未分类'} · 质量 {Math.round(item.qualityScore)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {versions.length > 0 && (
              <div className="mb-4">
                <h3 className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-2">版本记录</h3>
                <div className="space-y-2">
                  {versions.slice(0, 5).map((version) => (
                    <div
                      key={version.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-gray-50 px-3 py-2 dark:bg-white/[0.03]"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm text-gray-700 dark:text-gray-200">
                          v{version.version} · {version.snapshot.title || template.title}
                        </p>
                        <p className="text-xs text-gray-400 dark:text-gray-500">
                          {new Date(version.createdAt).toLocaleString('zh-CN')}
                        </p>
                      </div>
                      {canEdit && version.version !== template.version && (
                        <button
                          type="button"
                          onClick={() => handleRestoreVersion(version)}
                          className="flex-shrink-0 rounded-lg bg-white px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                        >
                          恢复
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="flex flex-wrap gap-2 pt-4 border-t border-gray-100 dark:border-white/[0.08]">
            <button
              onClick={() => applyTemplate(template)}
              className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-blue-50 px-3 py-2 text-sm font-medium text-blue-600 transition whitespace-nowrap hover:bg-blue-100 dark:bg-blue-500/10 dark:text-blue-400 dark:hover:bg-blue-500/20"
            >
              套用模板
            </button>
            {canEdit && (
              <button
                onClick={() => setTemplateEditor({ mode: 'edit', templateId: template.id })}
                className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-green-50 px-3 py-2 text-sm font-medium text-green-600 transition whitespace-nowrap hover:bg-green-100 dark:bg-green-500/10 dark:text-green-400 dark:hover:bg-green-500/20"
              >
                {canAdapt ? '改写为私有模板' : '编辑'}
              </button>
            )}
            <button
              onClick={() => runTemplateAction(() => duplicateTemplate(template.id))}
              className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-purple-50 px-3 py-2 text-sm font-medium text-purple-600 transition whitespace-nowrap hover:bg-purple-100 dark:bg-purple-500/10 dark:text-purple-400 dark:hover:bg-purple-500/20"
            >
              复制
            </button>
            {canSubmit && (
              <button
                onClick={() => runTemplateAction(() => submitTemplateForReview(template.id))}
                className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-sm font-medium text-amber-600 transition whitespace-nowrap hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
              >
                提交审核
              </button>
            )}
            {canReview && (
              <>
                <button
                  onClick={() => runTemplateAction(() => approveTemplate(template.id))}
                  className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-600 transition whitespace-nowrap hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
                >
                  通过
                </button>
                <button
                  onClick={() => {
                    const reason = window.prompt('填写驳回原因（可留空）') ?? ''
                    runTemplateAction(() => rejectTemplate(template.id, reason))
                  }}
                  className="inline-flex min-w-[7.5rem] flex-1 items-center justify-center gap-1.5 rounded-xl bg-rose-50 px-3 py-2 text-sm font-medium text-rose-600 transition whitespace-nowrap hover:bg-rose-100 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20"
                >
                  驳回
                </button>
              </>
            )}
            {canDelete && (
              <button
                onClick={handleDelete}
                className="flex h-10 w-10 items-center justify-center rounded-xl bg-red-50 text-red-600 transition hover:bg-red-100 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
                title="删除模板"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
            {canFavorite && (
              <button
                onClick={() => runTemplateAction(() => toggleTemplateFavorite(template.id))}
                className={`flex h-10 w-10 items-center justify-center rounded-xl transition ${
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
            )}
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
