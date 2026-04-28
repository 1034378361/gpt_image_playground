import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { ApiMode, PromptTemplateDraft, TaskParams } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { createTemplateFromDraft, createTemplateFromTask, updateTemplateInStore, useStore } from '../store'
import { deriveTemplateTitle, normalizeTemplateDraft, normalizeTemplateTags } from '../lib/templateUtils'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import Select from './Select'

export default function TemplateEditorModal() {
  const editor = useStore((s) => s.templateEditor)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)
  const templates = useStore((s) => s.templates)
  const tasks = useStore((s) => s.tasks)
  const prompt = useStore((s) => s.prompt)
  const params = useStore((s) => s.params)
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const setSelectedTemplateId = useStore((s) => s.setSelectedTemplateId)
  const setCurrentView = useStore((s) => s.setCurrentView)

  const initialDraft = useMemo(() => {
    if (!editor) return null
    if (editor.mode === 'edit') {
      const template = templates.find((item) => item.id === editor.templateId)
      if (!template) return null
      return {
        title: template.title,
        description: template.description,
        prompt: template.prompt,
        negativePrompt: template.negativePrompt,
        tags: template.tags,
        category: template.category,
        params: template.params,
        apiMode: template.apiMode,
        model: template.model,
        coverImageId: template.coverImageId,
        linkedTaskIds: template.linkedTaskIds,
        isFavorite: template.isFavorite,
      } satisfies PromptTemplateDraft
    }

    if (editor.mode === 'fromTask') {
      const task = tasks.find((item) => item.id === editor.taskId)
      if (!task) return null
      return {
        title: deriveTemplateTitle(task.prompt),
        description: '',
        prompt: task.prompt,
        tags: [],
        category: '',
        params: task.params,
        apiMode: settings.apiMode,
        model: settings.model,
        coverImageId: task.outputImages[0] ?? null,
        linkedTaskIds: [task.id],
        isFavorite: false,
      } satisfies PromptTemplateDraft
    }

    if (editor.mode === 'fromCurrent') {
      return {
        title: deriveTemplateTitle(prompt),
        description: '',
        prompt,
        tags: [],
        category: '',
        params,
        apiMode: settings.apiMode,
        model: settings.model,
        coverImageId: null,
        linkedTaskIds: [],
        isFavorite: false,
      } satisfies PromptTemplateDraft
    }

    return {
      title: '',
      description: '',
      prompt: '',
      tags: [],
      category: '',
      params,
      apiMode: settings.apiMode,
      model: settings.model,
      coverImageId: null,
      linkedTaskIds: [],
      isFavorite: false,
    } satisfies PromptTemplateDraft
  }, [editor, params, prompt, settings.apiMode, settings.model, tasks, templates])

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [templatePrompt, setTemplatePrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [category, setCategory] = useState('')
  const [draftParams, setDraftParams] = useState<TaskParams>({ ...DEFAULT_PARAMS })
  const [apiMode, setApiMode] = useState<ApiMode>('images')
  const [model, setModel] = useState('')
  const [isFavorite, setIsFavorite] = useState(false)

  useCloseOnEscape(Boolean(editor), () => setTemplateEditor(null))

  useEffect(() => {
    if (!initialDraft) return
    setTitle(initialDraft.title)
    setDescription(initialDraft.description)
    setTemplatePrompt(initialDraft.prompt)
    setNegativePrompt(initialDraft.negativePrompt ?? '')
    setTagsInput(initialDraft.tags.join(', '))
    setCategory(initialDraft.category)
    setDraftParams({ ...initialDraft.params })
    setApiMode(initialDraft.apiMode)
    setModel(initialDraft.model)
    setIsFavorite(Boolean(initialDraft.isFavorite))
  }, [initialDraft])

  if (!editor || !initialDraft) return null

  const setParamPatch = (patch: Partial<TaskParams>) => {
    setDraftParams((current) => ({ ...current, ...patch }))
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!templatePrompt.trim()) {
      showToast('模板提示词不能为空', 'error')
      return
    }

    const draft = normalizeTemplateDraft({
      ...initialDraft,
      title,
      description,
      prompt: templatePrompt,
      negativePrompt,
      tags: normalizeTemplateTags(tagsInput),
      category,
      params: draftParams,
      apiMode,
      model,
      isFavorite,
    })

    try {
      if (editor.mode === 'edit') {
        const updated = await updateTemplateInStore(editor.templateId, draft, { bumpVersion: true })
        if (updated) {
          setSelectedTemplateId(updated.id)
          showToast('模板已更新', 'success')
        }
      } else if (editor.mode === 'fromTask') {
        const task = tasks.find((item) => item.id === editor.taskId)
        if (task) {
          const created = await createTemplateFromTask(task, draft)
          setSelectedTemplateId(created.id)
          setCurrentView('templates')
          showToast('已从任务保存为模板', 'success')
        }
      } else {
        const created = await createTemplateFromDraft(draft)
        setSelectedTemplateId(created.id)
        setCurrentView('templates')
        showToast('模板已保存', 'success')
      }
      setTemplateEditor(null)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const dialogTitle =
    editor.mode === 'edit'
      ? '编辑模板'
      : editor.mode === 'fromTask'
      ? '从任务保存模板'
      : editor.mode === 'fromCurrent'
      ? '从当前输入保存模板'
      : '新建模板'

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      onClick={() => setTemplateEditor(null)}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <form
        onSubmit={handleSubmit}
        className="relative bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-3xl w-full max-h-[90vh] overflow-y-auto p-5 z-10 ring-1 ring-black/5 dark:ring-white/10 animate-modal-in"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 mb-4">
          <h2 className="text-base font-bold text-gray-800 dark:text-gray-100">{dialogTitle}</h2>
          <button
            type="button"
            onClick={() => setTemplateEditor(null)}
            className="p-1 rounded-full hover:bg-gray-100 dark:hover:bg-white/[0.06] transition text-gray-400"
            aria-label="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">标题</span>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              placeholder="模板标题"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">分类</span>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              placeholder="例如：产品图、插画、头像"
            />
          </label>
          <label className="sm:col-span-2 flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">描述</span>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              placeholder="用途、风格、适用场景"
            />
          </label>
          <label className="sm:col-span-2 flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">标签</span>
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              placeholder="用逗号分隔，例如：电商, 写实, 白底"
            />
          </label>
          <label className="sm:col-span-2 flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">Prompt</span>
            <textarea
              value={templatePrompt}
              onChange={(e) => setTemplatePrompt(e.target.value)}
              rows={5}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              placeholder="模板提示词"
            />
          </label>
          <label className="sm:col-span-2 flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">Negative Prompt</span>
            <textarea
              value={negativePrompt}
              onChange={(e) => setNegativePrompt(e.target.value)}
              rows={2}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              placeholder="可选"
            />
          </label>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">API mode</span>
            <Select
              value={apiMode}
              onChange={(value) => setApiMode(value as ApiMode)}
              options={[
                { label: 'images', value: 'images' },
                { label: 'responses', value: 'responses' },
              ]}
              className="px-3 py-2 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">模型</span>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">尺寸</span>
            <input
              value={draftParams.size}
              onChange={(e) => setParamPatch({ size: e.target.value })}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">数量</span>
            <input
              value={draftParams.n}
              type="number"
              min={1}
              max={4}
              onChange={(e) => setParamPatch({ n: Number(e.target.value) || DEFAULT_PARAMS.n })}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">质量</span>
            <Select
              value={draftParams.quality}
              onChange={(value) => setParamPatch({ quality: value as TaskParams['quality'] })}
              options={[
                { label: 'auto', value: 'auto' },
                { label: 'low', value: 'low' },
                { label: 'medium', value: 'medium' },
                { label: 'high', value: 'high' },
              ]}
              className="px-3 py-2 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">格式</span>
            <Select
              value={draftParams.output_format}
              onChange={(value) => setParamPatch({ output_format: value as TaskParams['output_format'] })}
              options={[
                { label: 'PNG', value: 'png' },
                { label: 'JPEG', value: 'jpeg' },
                { label: 'WebP', value: 'webp' },
              ]}
              className="px-3 py-2 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">压缩率</span>
            <input
              value={draftParams.output_compression ?? ''}
              type="number"
              min={0}
              max={100}
              onChange={(e) => setParamPatch({ output_compression: e.target.value === '' ? null : Number(e.target.value) })}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">审核</span>
            <Select
              value={draftParams.moderation}
              onChange={(value) => setParamPatch({ moderation: value as TaskParams['moderation'] })}
              options={[
                { label: 'auto', value: 'auto' },
                { label: 'low', value: 'low' },
              ]}
              className="px-3 py-2 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] text-sm"
            />
          </label>
        </div>

        <label className="mt-4 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
          <input
            type="checkbox"
            checked={isFavorite}
            onChange={(e) => setIsFavorite(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
          />
          收藏模板
        </label>

        <div className="mt-5 flex justify-end gap-2 border-t border-gray-100 pt-4 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={() => setTemplateEditor(null)}
            className="rounded-xl border border-gray-200 dark:border-white/[0.08] px-4 py-2 text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-white/[0.06] transition"
          >
            取消
          </button>
          <button
            type="submit"
            className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 transition"
          >
            保存模板
          </button>
        </div>
      </form>
    </div>
  )
}
