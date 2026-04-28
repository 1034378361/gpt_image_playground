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

export function extractTemplateVariables(...texts: Array<string | undefined | null>): string[] {
  const seen = new Set<string>()
  const vars: string[] = []
  const pattern = /\{\{\s*([a-zA-Z0-9_\u4e00-\u9fa5-]+)\s*\}\}/g

  for (const text of texts) {
    if (!text) continue
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(text))) {
      const name = match[1].trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      vars.push(name)
    }
  }

  return vars
}

export function fillTemplateVariables(text: string, values: Record<string, string>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_\u4e00-\u9fa5-]+)\s*\}\}/g, (_, name: string) => values[name.trim()]?.trim() ?? '')
}

export function composeTemplatePrompt(template: PromptTemplate, values: Record<string, string> = {}): string {
  const prompt = fillTemplateVariables(template.prompt, values).trim()
  const negativePrompt = template.negativePrompt
    ? fillTemplateVariables(template.negativePrompt, values).trim()
    : ''

  return negativePrompt
    ? `${prompt}\n\nNegative prompt: ${negativePrompt}`
    : prompt
}
