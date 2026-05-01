import { useEffect, useState } from 'react'
import type { PromptTemplate } from '../types'
import {
  applyTemplate,
  duplicateTemplate,
  ensureImageCached,
  getCachedImage,
  removeTemplate,
  toggleTemplateFavorite,
  useStore,
} from '../store'
import { approveTemplate, rejectTemplate, submitTemplateForReview } from '../storeBackend'
import { UNASSIGNED_PROJECT_ID } from '../lib/templateUtils'

interface Props {
  template: PromptTemplate
}

export default function TemplateCard({ template }: Props) {
  const [coverSrc, setCoverSrc] = useState('')
  const setSelectedTemplateId = useStore((s) => s.setSelectedTemplateId)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const backendUser = useStore((s) => s.backendUser)
  const currentProjectId = useStore((s) => s.currentProjectId)
  const taskCount = useStore((s) =>
    s.tasks.filter((task) => task.templateId === template.id || template.linkedTaskIds.includes(task.id)).length,
  )
  const useCount = Math.max(template.usageCount ?? 0, taskCount)
  const isOwner = backendUser?.id === template.userId
  const isAdmin = backendUser?.role === 'admin'
  const canFavorite = Boolean(isOwner || isAdmin)
  const canManageDirectly = Boolean(isAdmin || (isOwner && template.submissionStatus !== 'submitted' && template.visibility !== 'public' && template.submissionStatus !== 'approved'))
  const canAdapt = Boolean(template.visibility === 'public' && !isAdmin)
  const canEdit = canManageDirectly || canAdapt
  const canDelete = canManageDirectly
  const canSubmit = Boolean(isOwner && !isAdmin && template.visibility !== 'public' && template.submissionStatus !== 'submitted' && template.submissionStatus !== 'approved')
  const canReview = Boolean(isAdmin && template.submissionStatus === 'submitted')
  const ownershipLabel =
    template.visibility === 'public'
      ? '来自公共模板库'
      : template.projectId && template.projectId !== UNASSIGNED_PROJECT_ID
      ? '项目私有模板'
      : '未归类私有模板'

  useEffect(() => {
    let cancelled = false
    setCoverSrc(template.externalCoverUrl || template.exampleImages[0] || '')
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
  }, [template.coverImageId, template.exampleImages, template.externalCoverUrl])

  const handleDelete = () => {
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

  return (
    <div
      className="group flex h-full cursor-pointer flex-col overflow-hidden rounded-xl border border-gray-200 bg-white transition hover:border-gray-300 hover:shadow-lg dark:border-white/[0.08] dark:bg-gray-900 dark:hover:border-white/[0.18] dark:hover:bg-gray-800/80"
      onClick={() => setSelectedTemplateId(template.id)}
    >
      <div className="relative aspect-[4/5] min-h-[15rem] overflow-hidden bg-gray-100 dark:bg-black/20">
        {coverSrc ? (
          <>
            <img
              src={coverSrc}
              className="absolute inset-0 h-full w-full scale-110 object-cover opacity-25 blur-2xl"
              loading="lazy"
              alt=""
              aria-hidden="true"
            />
            <div className="absolute inset-0 bg-gradient-to-b from-white/15 via-transparent to-black/10 dark:from-white/[0.04] dark:to-black/35" />
            <img
              src={coverSrc}
              data-image-id={template.coverImageId ?? undefined}
              data-template-id={template.id}
              className="relative z-10 h-full w-full object-contain p-3 sm:p-4"
              loading="lazy"
              alt=""
            />
          </>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-gray-300 dark:text-gray-600">
            <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428 12 22.856l-7.428-7.428a5.25 5.25 0 0 1 7.428-7.428 5.25 5.25 0 0 1 7.428 7.428Z" />
            </svg>
            <span className="text-xs">暂无封面</span>
          </div>
        )}
        <div className="absolute inset-x-0 top-0 z-20 p-2">
          <div className="flex flex-wrap items-center gap-1">
            {template.category && (
              <span className="rounded-full bg-black/50 px-2 py-0.5 text-xs text-white backdrop-blur-sm">
                {template.category}
              </span>
            )}
            {template.isFeatured && (
              <span className="rounded-full bg-fuchsia-500/80 px-2 py-0.5 text-xs text-white backdrop-blur-sm">
                精选
              </span>
            )}
            <span className={`rounded-full px-2 py-0.5 text-xs backdrop-blur-sm ${
              template.visibility === 'public'
                ? 'bg-emerald-500/80 text-white'
                : template.submissionStatus === 'submitted'
                ? 'bg-amber-500/80 text-white'
                : template.submissionStatus === 'rejected'
                ? 'bg-rose-500/80 text-white'
                : 'bg-black/50 text-white'
            }`}>
              {template.visibility === 'public'
                ? '公共'
                : template.submissionStatus === 'submitted'
                ? '待审核'
                : template.submissionStatus === 'rejected'
                ? '已驳回'
                : '私有'}
            </span>
            <span className="rounded-full bg-black/50 px-2 py-0.5 text-xs text-white/90 backdrop-blur-sm">
              {useCount} 次
            </span>
            <span className="rounded-full bg-black/50 px-2 py-0.5 text-xs text-white/90 backdrop-blur-sm">
              质量 {Math.round(template.qualityScore ?? 0)}
            </span>
          </div>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="font-semibold text-gray-800 dark:text-gray-100 truncate">{template.title}</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 leading-relaxed line-clamp-2">
              {template.description || template.prompt || '(无提示词)'}
            </p>
          </div>
          {canFavorite && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                runTemplateAction(() => toggleTemplateFavorite(template.id))
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
          )}
        </div>

        {template.tags.length > 0 && (
          <div className="mt-3 flex gap-1.5 overflow-x-auto hide-scrollbar mask-edge-r">
            {[...template.tags, ...template.collections].slice(0, 5).map((tag) => (
              <span key={tag} className="flex-shrink-0 rounded-full bg-blue-50 dark:bg-blue-500/10 px-2 py-0.5 text-xs text-blue-600 dark:text-blue-400">
                {tag}
              </span>
            ))}
          </div>
        )}

        {(template.sourceName || template.sourceAuthor) && (
          <div className="mt-2 flex min-w-0 items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
            <span className="truncate">{template.sourceName || '来源'}</span>
            {template.sourceAuthor && <span className="flex-shrink-0">· {template.sourceAuthor}</span>}
          </div>
        )}
        <div className="mt-2 flex min-w-0 items-center gap-1 text-[11px] text-gray-400 dark:text-gray-500">
          <span className="truncate">{ownershipLabel}</span>
        </div>

        <div className="mt-auto">
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-gray-400 dark:text-gray-500">
            <span>使用 {useCount}</span>
            <span>收藏 {template.favoriteCount ?? Number(template.isFavorite)}</span>
            <span>质量 {Math.round(template.qualityScore ?? 0)}</span>
            {(template.successCount || template.failureCount) ? (
              <span>成功 {template.successCount}/{template.successCount + template.failureCount}</span>
            ) : null}
          </div>

          <div className="mt-3 flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => applyTemplate(template)}
              className="rounded-md p-1.5 text-gray-400 transition hover:bg-blue-50 hover:text-blue-500 dark:hover:bg-blue-950/30"
              title="套用模板"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0-5 5m5-5H6" />
              </svg>
            </button>
            <button
              onClick={() => runTemplateAction(() => duplicateTemplate(template.id))}
              className="rounded-md p-1.5 text-gray-400 transition hover:bg-purple-50 hover:text-purple-500 dark:hover:bg-purple-950/30"
              title={template.visibility === 'public' && currentProjectId ? '复制到当前项目' : '复制模板'}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
              </svg>
            </button>
            {canEdit && (
              <button
                onClick={() => setTemplateEditor({ mode: 'edit', templateId: template.id })}
                className="rounded-md p-1.5 text-gray-400 transition hover:bg-green-50 hover:text-green-500 dark:hover:bg-green-950/30"
                title={canAdapt ? '改写为私有模板' : '编辑模板'}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5m-1.414-9.414a2 2 0 1 1 2.828 2.828L11.828 15H9v-2.828z" />
                </svg>
              </button>
            )}
            {canSubmit && (
              <button
                onClick={() => runTemplateAction(() => submitTemplateForReview(template.id))}
                className="rounded-md p-1.5 text-gray-400 transition hover:bg-amber-50 hover:text-amber-500 dark:hover:bg-amber-950/30"
                title="提交到公共模板库"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
                </svg>
              </button>
            )}
            {canReview && (
              <>
                <button
                  onClick={() => runTemplateAction(() => approveTemplate(template.id))}
                  className="rounded-md p-1.5 text-gray-400 transition hover:bg-emerald-50 hover:text-emerald-500 dark:hover:bg-emerald-950/30"
                  title="通过审核"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="m5 13 4 4L19 7" />
                  </svg>
                </button>
                <button
                  onClick={() => {
                    const reason = window.prompt('填写驳回原因（可留空）') ?? ''
                    runTemplateAction(() => rejectTemplate(template.id, reason))
                  }}
                  className="rounded-md p-1.5 text-gray-400 transition hover:bg-rose-50 hover:text-rose-500 dark:hover:bg-rose-950/30"
                  title="驳回投稿"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              </>
            )}
            {canDelete && (
              <button
                onClick={handleDelete}
                className="rounded-md p-1.5 text-gray-400 transition hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/30"
                title="删除模板"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
