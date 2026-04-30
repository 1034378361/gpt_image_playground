import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import type { ApiMode, PromptTemplateDraft, TaskParams, TemplateFormField } from '../types'
import { DEFAULT_PARAMS } from '../types'
import { createTemplateFromDraft, createTemplateFromTask, updateTemplateInStore, useStore } from '../store'
import {
  deriveTemplateTitle,
  extractTemplateVariableDefinitions,
  isApprovedPublicTemplate,
  normalizeSelectedProjectId,
  normalizeTemplateDraft,
  normalizeTemplateTags,
} from '../lib/templateUtils'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import Select from './Select'

export default function TemplateEditorModal() {
  const editor = useStore((s) => s.templateEditor)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)
  const templates = useStore((s) => s.templates)
  const tasks = useStore((s) => s.tasks)
  const channels = useStore((s) => s.channels)
  const projects = useStore((s) => s.projects)
  const prompt = useStore((s) => s.prompt)
  const params = useStore((s) => s.params)
  const settings = useStore((s) => s.settings)
  const currentProjectId = useStore((s) => s.currentProjectId)
  const backendUser = useStore((s) => s.backendUser)
  const showToast = useStore((s) => s.showToast)
  const setSelectedTemplateId = useStore((s) => s.setSelectedTemplateId)
  const setCurrentView = useStore((s) => s.setCurrentView)
  const editingTemplate = useMemo(
    () => (editor?.mode === 'edit' ? templates.find((item) => item.id === editor.templateId) ?? null : null),
    [editor, templates],
  )
  const canDirectlyEditTemplate = Boolean(
    editingTemplate
      && (
        backendUser?.role === 'admin'
        || (
          backendUser?.id === editingTemplate.userId
          && editingTemplate.submissionStatus !== 'submitted'
          && !isApprovedPublicTemplate(editingTemplate)
        )
      ),
  )
  const willForkReadonlyTemplate = Boolean(editingTemplate && !canDirectlyEditTemplate)

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
        channelId: template.channelId ?? settings.channelId,
        apiMode: template.apiMode,
        model: template.model,
        coverImageId: template.coverImageId,
        externalCoverUrl: template.externalCoverUrl,
        exampleImages: template.exampleImages,
        recommendedChannelId: template.recommendedChannelId,
        recommendedApiMode: template.recommendedApiMode,
        recommendedModel: template.recommendedModel,
        linkedTaskIds: template.linkedTaskIds,
        isFavorite: template.isFavorite,
        sourceName: template.sourceName,
        sourceUrl: template.sourceUrl,
        sourceAuthor: template.sourceAuthor,
        licenseName: template.licenseName,
        projectId: template.projectId,
        formFields: template.formFields,
        collections: template.collections,
        isFeatured: template.isFeatured,
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
        channelId: settings.channelId,
        apiMode: settings.apiMode,
        model: settings.model,
        coverImageId: task.outputImages[0] ?? null,
        externalCoverUrl: null,
        exampleImages: task.outputImages,
        recommendedChannelId: settings.channelId,
        recommendedApiMode: settings.apiMode,
        recommendedModel: settings.model,
        linkedTaskIds: [task.id],
        isFavorite: false,
        projectId: task.projectId ?? currentProjectId,
        formFields: [],
        collections: [],
        isFeatured: false,
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
        channelId: settings.channelId,
        apiMode: settings.apiMode,
        model: settings.model,
        coverImageId: null,
        externalCoverUrl: null,
        exampleImages: [],
        recommendedChannelId: settings.channelId,
        recommendedApiMode: settings.apiMode,
        recommendedModel: settings.model,
        linkedTaskIds: [],
        isFavorite: false,
        projectId: currentProjectId,
        formFields: [],
        collections: [],
        isFeatured: false,
      } satisfies PromptTemplateDraft
    }

    return {
      title: '',
        description: '',
        prompt: '',
        tags: [],
        category: '',
        params,
        channelId: settings.channelId,
        apiMode: settings.apiMode,
        model: settings.model,
        coverImageId: null,
        externalCoverUrl: null,
        exampleImages: [],
        recommendedChannelId: settings.channelId,
        recommendedApiMode: settings.apiMode,
        recommendedModel: settings.model,
        linkedTaskIds: [],
        isFavorite: false,
        projectId: currentProjectId,
        formFields: [],
        collections: [],
        isFeatured: false,
    } satisfies PromptTemplateDraft
  }, [currentProjectId, editor, params, prompt, settings.apiMode, settings.channelId, settings.model, tasks, templates])

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [templatePrompt, setTemplatePrompt] = useState('')
  const [negativePrompt, setNegativePrompt] = useState('')
  const [tagsInput, setTagsInput] = useState('')
  const [category, setCategory] = useState('')
  const [draftParams, setDraftParams] = useState<TaskParams>({ ...DEFAULT_PARAMS })
  const [projectId, setProjectId] = useState<string | null>(null)
  const [channelId, setChannelId] = useState('')
  const [apiMode, setApiMode] = useState<ApiMode>('images')
  const [model, setModel] = useState('')
  const [isFavorite, setIsFavorite] = useState(false)
  const [collectionsInput, setCollectionsInput] = useState('')
  const [formFields, setFormFields] = useState<TemplateFormField[]>([])
  const [isFeatured, setIsFeatured] = useState(false)

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
    setProjectId(normalizeSelectedProjectId(initialDraft.projectId) ?? normalizeSelectedProjectId(currentProjectId))
    setChannelId(initialDraft.channelId ?? settings.channelId)
    setApiMode(initialDraft.apiMode)
    setModel(initialDraft.model)
    setIsFavorite(Boolean(initialDraft.isFavorite))
    setCollectionsInput((initialDraft.collections ?? []).join(', '))
    setFormFields(initialDraft.formFields ?? [])
    setIsFeatured(Boolean(initialDraft.isFeatured))
  }, [currentProjectId, initialDraft, settings.channelId])

  const selectedChannel = useMemo(
    () => channels.find((item) => item.id === channelId) ?? null,
    [channelId, channels],
  )

  const availableModels = useMemo(
    () => selectedChannel?.models.filter((item) => item.enabled) ?? [],
    [selectedChannel],
  )

  useEffect(() => {
    if (!selectedChannel) return
    const selectedModel = availableModels.find((item) => item.id === model) ?? availableModels[0]
    if (!selectedModel) return
    if (selectedModel.id !== model) {
      setModel(selectedModel.id)
    }
    if (selectedModel.apiMode !== apiMode) {
      setApiMode(selectedModel.apiMode)
    }
  }, [apiMode, availableModels, model, selectedChannel])

  if (!editor || !initialDraft) return null

  const setParamPatch = (patch: Partial<TaskParams>) => {
    setDraftParams((current) => ({ ...current, ...patch }))
  }

  const projectOptions = [
    { label: '未归类', value: '__none__' },
    ...projects
      .filter((project) => !project.isArchived || project.id === projectId)
      .map((project) => ({ label: project.name, value: project.id })),
  ]

  const patchFormField = (index: number, patch: Partial<TemplateFormField>) => {
    setFormFields((current) => current.map((field, fieldIndex) => (fieldIndex === index ? { ...field, ...patch } : field)))
  }

  const addFormField = () => {
    setFormFields((current) => [
      ...current,
      {
        key: `field_${current.length + 1}`,
        label: `字段 ${current.length + 1}`,
        type: 'text',
        required: true,
        defaultValue: '',
        options: [],
        placeholder: '',
        helpText: '',
      },
    ])
  }

  const inferFormFields = () => {
    const inferred = extractTemplateVariableDefinitions(templatePrompt, negativePrompt).map((item, index) => ({
      key: item.name,
      label: item.name,
      type: item.type,
      required: item.required,
      defaultValue: item.defaultValue,
      options: item.options,
      placeholder: item.example,
      helpText: item.description || `变量 ${index + 1}`,
    })) satisfies TemplateFormField[]
    if (!inferred.length) {
      showToast('当前提示词里没有识别到变量占位符', 'error')
      return
    }
    setFormFields(inferred)
  }

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!templatePrompt.trim()) {
      showToast('模板提示词不能为空', 'error')
      return
    }
    if (!channelId || channelId === '__none__' || !model || model === '__none__') {
      showToast('请先选择有效的渠道和模型', 'error')
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
      channelId,
      apiMode,
      model,
      isFavorite,
      exampleImages: initialDraft.exampleImages,
      recommendedChannelId: channelId,
      recommendedApiMode: apiMode,
      recommendedModel: model,
      sourceName: initialDraft.sourceName,
      sourceUrl: initialDraft.sourceUrl,
      sourceAuthor: initialDraft.sourceAuthor,
      licenseName: initialDraft.licenseName,
      externalCoverUrl: initialDraft.externalCoverUrl,
      projectId: projectId && projectId !== '__none__' ? projectId : null,
      collections: collectionsInput.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
      formFields,
      isFeatured: backendUser?.role === 'admin' ? isFeatured : false,
    })

    try {
      if (editor.mode === 'edit') {
        if (willForkReadonlyTemplate) {
          const created = await createTemplateFromDraft(draft)
          setSelectedTemplateId(created.id)
          setCurrentView('templates')
          showToast(created.projectId ? '已保存为当前项目中的私有模板' : '已另存为私有模板', 'success')
        } else {
          const updated = await updateTemplateInStore(editor.templateId, draft, { bumpVersion: true })
          if (updated) {
            setSelectedTemplateId(updated.id)
            showToast('模板已更新', 'success')
          }
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
        {willForkReadonlyTemplate && (
          <div className="mb-4 rounded-2xl border border-emerald-200 bg-emerald-50/80 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-200">
            这是公共模板。保存时会创建你的私有副本，并优先归到当前项目。
          </div>
        )}

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
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">所属项目</span>
            <Select
              value={projectId || '__none__'}
              onChange={(value) => setProjectId(String(value) === '__none__' ? null : String(value))}
              options={projectOptions}
              className="px-3 py-2 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">专题标签</span>
            <input
              value={collectionsInput}
              onChange={(e) => setCollectionsInput(e.target.value)}
              className="rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/30"
              placeholder="例如：product-hero, portrait-photo"
            />
          </label>
          {backendUser?.role === 'admin' && (
            <label className="sm:col-span-2 flex items-center gap-2 rounded-xl border border-gray-200/60 bg-white/70 px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300">
              <input type="checkbox" checked={isFeatured} onChange={(e) => setIsFeatured(e.target.checked)} />
              设为精选模板
            </label>
          )}
        </div>

        <div className="mt-4 rounded-2xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-100">表单字段</h3>
              <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">给模板定义结构化输入，套用时会自动弹表单。</p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={inferFormFields}
                className="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]"
              >
                智能识别
              </button>
              <button
                type="button"
                onClick={addFormField}
                className="rounded-xl bg-blue-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-blue-600"
              >
                添加字段
              </button>
            </div>
          </div>
          <div className="space-y-3">
            {formFields.map((field, index) => (
              <div key={`${field.key}-${index}`} className="rounded-xl border border-gray-200/70 bg-white p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                <div className="grid gap-2 sm:grid-cols-2">
                  <input
                    value={field.label}
                    onChange={(e) => patchFormField(index, { label: e.target.value })}
                    placeholder="字段名称"
                    className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  />
                  <input
                    value={field.key}
                    onChange={(e) => patchFormField(index, { key: e.target.value })}
                    placeholder="变量 key"
                    className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  />
                  <Select
                    value={field.type}
                    onChange={(value) => patchFormField(index, { type: value as TemplateFormField['type'] })}
                    options={[
                      { label: '文本', value: 'text' },
                      { label: '长文本', value: 'textarea' },
                      { label: '选项', value: 'select' },
                      { label: '颜色', value: 'color' },
                      { label: '数字', value: 'number' },
                      { label: '图片', value: 'image' },
                    ]}
                    className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  />
                  <input
                    value={field.defaultValue}
                    onChange={(e) => patchFormField(index, { defaultValue: e.target.value })}
                    placeholder="默认值"
                    className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  />
                  <input
                    value={field.placeholder}
                    onChange={(e) => patchFormField(index, { placeholder: e.target.value })}
                    placeholder="占位提示"
                    className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  />
                  <input
                    value={field.options.join(', ')}
                    onChange={(e) => patchFormField(index, {
                      options: e.target.value.split(/[,，]/).map((item) => item.trim()).filter(Boolean),
                    })}
                    placeholder="选项，用逗号分隔"
                    className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  />
                  <input
                    value={field.helpText}
                    onChange={(e) => patchFormField(index, { helpText: e.target.value })}
                    placeholder="补充说明"
                    className="sm:col-span-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  />
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <input
                      type="checkbox"
                      checked={field.required}
                      onChange={(e) => patchFormField(index, { required: e.target.checked })}
                    />
                    必填
                  </label>
                  <button
                    type="button"
                    onClick={() => setFormFields((current) => current.filter((_, fieldIndex) => fieldIndex !== index))}
                    className="rounded-lg px-2 py-1 text-xs text-red-500 transition hover:bg-red-50 dark:hover:bg-red-500/10"
                  >
                    删除字段
                  </button>
                </div>
              </div>
            ))}
            {!formFields.length && (
              <div className="rounded-xl border border-dashed border-gray-200 px-3 py-6 text-center text-xs text-gray-400 dark:border-white/[0.08] dark:text-gray-500">
                暂时没有结构化字段，模板会继续按原始提示词直接套用。
              </div>
            )}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">渠道</span>
            <Select
              value={channelId || '__none__'}
              onChange={(value) => setChannelId(String(value))}
              options={
                channels.length
                  ? channels.map((channel) => ({ label: channel.name, value: channel.id }))
                  : [{ label: '请先让管理员配置渠道', value: '__none__' }]
              }
              className="px-3 py-2 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] text-sm"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-gray-400 dark:text-gray-500">模型</span>
            <Select
              value={model || '__none__'}
              onChange={(value) => setModel(String(value))}
              options={
                availableModels.length
                  ? availableModels.map((item) => ({ label: item.label || item.id, value: item.id }))
                  : [{ label: selectedChannel ? '当前渠道暂无可用模型' : '请先选择渠道', value: '__none__' }]
              }
              disabled={!selectedChannel || !availableModels.length}
              className="px-3 py-2 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.03] text-sm"
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
