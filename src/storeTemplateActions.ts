import type { PromptTemplate, PromptTemplateDraft, TaskRecord } from './types'
import * as backendApi from './lib/backendApi'
import { normalizeSelectedProjectId, normalizeTemplateDraft } from './lib/templateUtils'
import { updateTaskInStore } from './storeTaskMutations'
import { useStore } from './store'

function assertServerStorageReady() {
  if (!useStore.getState().backendUser) {
    throw new Error('请先登录后端账户')
  }
}

export async function createTemplateFromDraft(draft: PromptTemplateDraft): Promise<PromptTemplate> {
  const normalized = normalizeTemplateDraft(draft)
  assertServerStorageReady()
  const template = await backendApi.createTemplate(useStore.getState().settings, normalized)
  const state = useStore.getState()
  const nextTemplates = [template, ...state.templates]
  state.setTemplates(nextTemplates)
  state.setTemplatePage({ total: state.templatePage.total + 1, loaded: nextTemplates.length })
  return template
}

export async function updateTemplateInStore(
  templateId: string,
  patch: Partial<Omit<PromptTemplate, 'id' | 'createdAt'>>,
  options: { bumpVersion?: boolean } = {},
): Promise<PromptTemplate | null> {
  void options
  const { templates, setTemplates } = useStore.getState()
  const existing = templates.find((template) => template.id === templateId)
  if (!existing) return null
  assertServerStorageReady()
  const normalizedPatch = patch.tags || patch.title || patch.description || patch.prompt || patch.model || patch.category || patch.projectId !== undefined
    ? normalizeTemplateDraft({ ...existing, ...patch, tags: patch.tags ?? existing.tags })
    : null
  const serverPatch = normalizedPatch
    ? { ...patch, ...normalizedPatch }
    : patch
  const updated = await backendApi.patchTemplate(useStore.getState().settings, templateId, serverPatch)
  setTemplates(templates.map((template) => (template.id === templateId ? updated : template)))
  return updated
}

export async function removeTemplate(templateId: string) {
  const { templates, setTemplates, templateSubmissions, setTemplateSubmissions, selectedTemplateId, activeTemplateId, showToast } = useStore.getState()
  assertServerStorageReady()
  const nextTemplates = templates.filter((template) => template.id !== templateId)
  setTemplates(nextTemplates)
  useStore.getState().setTemplatePage({
    total: Math.max(0, useStore.getState().templatePage.total - 1),
    loaded: nextTemplates.length,
  })
  setTemplateSubmissions(templateSubmissions.filter((template) => template.id !== templateId))
  await backendApi.deleteTemplate(useStore.getState().settings, templateId)
  if (selectedTemplateId === templateId) useStore.getState().setSelectedTemplateId(null)
  if (activeTemplateId === templateId) useStore.getState().setActiveTemplateId(null)
  showToast('模板已删除', 'success')
}

export async function removeMultipleTemplates(templateIds: string[]) {
  if (!templateIds.length) return
  const { templates, setTemplates, templateSubmissions, setTemplateSubmissions, selectedTemplateId, activeTemplateId, showToast } = useStore.getState()
  assertServerStorageReady()
  const toDelete = new Set(templateIds)
  const nextTemplates = templates.filter((template) => !toDelete.has(template.id))
  setTemplates(nextTemplates)
  useStore.getState().setTemplatePage({
    total: Math.max(0, useStore.getState().templatePage.total - toDelete.size),
    loaded: nextTemplates.length,
  })
  setTemplateSubmissions(templateSubmissions.filter((template) => !toDelete.has(template.id)))
  await backendApi.batchDeleteTemplates(useStore.getState().settings, templateIds)
  if (selectedTemplateId && toDelete.has(selectedTemplateId)) useStore.getState().setSelectedTemplateId(null)
  if (activeTemplateId && toDelete.has(activeTemplateId)) useStore.getState().setActiveTemplateId(null)
  showToast(`已删除 ${templateIds.length} 个模板`, 'success')
}

export async function duplicateTemplate(templateId: string): Promise<PromptTemplate | null> {
  const state = useStore.getState()
  const template = state.templates.find((item) => item.id === templateId)
  if (!template) return null
  assertServerStorageReady()
  const targetProjectId = normalizeSelectedProjectId(state.currentProjectId) ?? normalizeSelectedProjectId(template.projectId)
  const copy = await createTemplateFromDraft({
    title: `${template.title} 副本`,
    description: template.description,
    prompt: template.prompt,
    negativePrompt: template.negativePrompt,
    tags: template.tags,
    category: template.category,
    params: template.params,
    channelId: template.channelId,
    apiMode: template.apiMode,
    model: template.model,
    coverImageId: template.coverImageId,
    externalCoverUrl: template.externalCoverUrl,
    exampleImages: template.exampleImages,
    recommendedChannelId: template.recommendedChannelId,
    recommendedApiMode: template.recommendedApiMode,
    recommendedModel: template.recommendedModel,
    linkedTaskIds: [],
    isFavorite: false,
    sourceName: template.sourceName,
    sourceUrl: template.sourceUrl,
    sourceAuthor: template.sourceAuthor,
    licenseName: template.licenseName,
    projectId: targetProjectId,
    formFields: template.formFields,
    collections: template.collections,
    isFeatured: false,
  })
  useStore.getState().showToast(targetProjectId ? '模板已复制到当前项目' : '模板已复制', 'success')
  return copy
}

export async function toggleTemplateFavorite(templateId: string) {
  const template = useStore.getState().templates.find((item) => item.id === templateId)
  if (!template) return
  await updateTemplateInStore(templateId, { isFavorite: !template.isFavorite })
}

export async function setTemplateCover(templateId: string, imageId: string) {
  assertServerStorageReady()
  const updated = await backendApi.setTemplateCover(useStore.getState().settings, templateId, imageId)
    .then((template) => {
      useStore.getState().setTemplates(
        useStore.getState().templates.map((item) => (item.id === templateId ? template : item)),
      )
      return template
    })
  if (updated) {
    useStore.getState().showToast('已设为模板封面', 'success')
  }
}

export async function createTemplateFromTask(task: TaskRecord, draft: PromptTemplateDraft): Promise<PromptTemplate> {
  const template = await createTemplateFromDraft({
    ...draft,
    linkedTaskIds: [...new Set([task.id, ...(draft.linkedTaskIds ?? [])])],
  })
  updateTaskInStore(task.id, {
    templateId: template.id,
    templateVersionId: String(template.version),
  })
  return template
}
