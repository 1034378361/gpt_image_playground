import type { PromptTemplate, PromptTemplateDraft, TemplateFilters } from '../types'

export const ALL_TEMPLATE_CATEGORIES = '__all__'
export const ALL_TEMPLATE_TAGS = '__all__'

export function normalizeTemplateTags(tags: string[] | string): string[] {
  const values = Array.isArray(tags) ? tags : tags.split(',')
  const seen = new Set<string>()
  const normalized: string[] = []

  for (const raw of values) {
    const tag = raw.trim()
    const key = tag.toLowerCase()
    if (!tag || seen.has(key)) continue
    seen.add(key)
    normalized.push(tag)
  }

  return normalized
}

export function deriveTemplateTitle(prompt: string): string {
  const normalized = prompt.replace(/\s+/g, ' ').trim()
  if (!normalized) return '未命名模板'
  return normalized.length > 28 ? `${normalized.slice(0, 28)}...` : normalized
}

export function normalizeTemplateDraft(draft: PromptTemplateDraft): PromptTemplateDraft {
  return {
    ...draft,
    title: draft.title.trim() || deriveTemplateTitle(draft.prompt),
    description: draft.description.trim(),
    prompt: draft.prompt.trim(),
    negativePrompt: draft.negativePrompt?.trim() || undefined,
    tags: normalizeTemplateTags(draft.tags),
    category: draft.category.trim(),
    model: draft.model.trim(),
    linkedTaskIds: [...new Set(draft.linkedTaskIds ?? [])],
    coverImageId: draft.coverImageId || null,
    isFavorite: Boolean(draft.isFavorite),
  }
}

export function filterTemplates(templates: PromptTemplate[], filters: TemplateFilters): PromptTemplate[] {
  const query = filters.query.trim().toLowerCase()
  const category = filters.category
  const tag = filters.tag

  return templates
    .filter((template) => {
      if (filters.favoriteOnly && !template.isFavorite) return false
      if (category && category !== ALL_TEMPLATE_CATEGORIES && template.category !== category) return false
      if (tag && tag !== ALL_TEMPLATE_TAGS && !template.tags.includes(tag)) return false
      if (!query) return true

      const searchable = [
        template.title,
        template.description,
        template.prompt,
        template.negativePrompt ?? '',
        template.category,
        template.tags.join(' '),
        template.model,
      ].join(' ').toLowerCase()
      return searchable.includes(query)
    })
    .sort((a, b) => Number(b.isFavorite) - Number(a.isFavorite) || b.updatedAt - a.updatedAt)
}

export function getTemplateCategories(templates: PromptTemplate[]): string[] {
  return [...new Set(templates.map((template) => template.category).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  )
}

export function getTemplateTags(templates: PromptTemplate[]): string[] {
  return [...new Set(templates.flatMap((template) => template.tags))].sort((a, b) =>
    a.localeCompare(b, 'zh-CN'),
  )
}

export function duplicateTemplateRecord(template: PromptTemplate, id: string, now: number): PromptTemplate {
  return {
    ...template,
    id,
    title: `${template.title} 副本`,
    isFavorite: false,
    linkedTaskIds: [],
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}
