import type { BackendUser, PromptTemplate, PromptTemplateDraft, TemplateFilters, TemplateFormField } from '../types'

export const ALL_TEMPLATE_CATEGORIES = '__all__'
export const ALL_TEMPLATE_TAGS = '__all__'
export const ALL_TEMPLATE_COLLECTIONS = '__all__'
export const UNASSIGNED_PROJECT_ID = '__unassigned__'

const TEMPLATE_COLLECTIONS = [
  { id: 'product-hero', label: '商品主图', terms: ['product', 'e-commerce', 'commerce', '商品', '产品', '电商', '主图', '货架', '包装', 'skincare', 'perfume', 'bottle'] },
  { id: 'poster-cover', label: '海报封面', terms: ['poster', 'ad', 'advertising', 'banner', 'flyer', 'campaign', 'social', '海报', '封面', '广告', '小红书', '社媒'] },
  { id: 'portrait-photo', label: '头像写真', terms: ['portrait', 'headshot', 'photo', 'photography', '肖像', '头像', '写真', '人像', '证件照', 'face'] },
  { id: 'character-sheet', label: '角色卡', terms: ['character', 'mascot', 'sheet', 'figure', '角色', '角色卡', '设定', '吉祥物', 'anime'] },
  { id: 'ui-mockup', label: 'UI Mockup', terms: ['ui', 'interface', 'dashboard', 'mockup', 'app', 'web', 'screen', '界面', '应用', '仪表盘'] },
  { id: 'logo-type', label: 'Logo 字体', terms: ['logo', 'brand', 'branding', 'typography', 'wordmark', '字体', '字标', '标志', '品牌'] },
] as const

const TEMPLATE_QUERY_DICTIONARY: Record<string, string[]> = {
  商品: ['product', 'e-commerce', 'commerce', '广告', '主图', '产品', '电商', '包装'],
  产品: ['product', '商品', '主图', 'e-commerce', 'packshot'],
  电商: ['e-commerce', 'commerce', '商品', '产品', '主图', 'banner'],
  主图: ['product', 'e-commerce', '商品', '产品', 'packshot'],
  包装: ['package', 'packaging', 'product', '商品'],
  海报: ['poster', 'ad', 'advertising', 'banner', 'flyer', 'campaign'],
  封面: ['poster', 'banner', 'cover', '小红书', 'social'],
  小红书: ['poster', 'cover', 'banner', 'social', '广告', '社媒'],
  社媒: ['social', 'poster', 'cover', 'banner'],
  广告: ['ad', 'advertising', 'poster', 'campaign', '商品'],
  头像: ['portrait', 'headshot', 'profile', '肖像', '人像'],
  肖像: ['portrait', 'headshot', '头像', '人像'],
  人像: ['portrait', 'photo', 'headshot', '写真'],
  写真: ['portrait', 'photography', 'photo', '人像'],
  证件照: ['headshot', 'portrait', 'profile'],
  角色: ['character', 'mascot', 'figure', '角色卡', '设定'],
  角色卡: ['character', 'sheet', 'mascot', '设定'],
  吉祥物: ['mascot', 'character', 'logo'],
  字体: ['typography', 'text', 'logo', 'wordmark', '字标'],
  字标: ['wordmark', 'typography', 'logo', 'brand'],
  界面: ['ui', 'interface', 'dashboard', 'app', 'mockup'],
  应用: ['app', 'ui', 'interface', 'mockup'],
  仪表盘: ['dashboard', 'ui', 'interface'],
  图标: ['icon', 'logo', 'symbol'],
  logo: ['标志', '图标', 'brand', 'wordmark', '字标'],
  品牌: ['brand', 'branding', 'logo', 'wordmark', '标志'],
  标志: ['logo', 'icon', 'brand', '字标'],
  写实: ['photo', 'photorealistic', 'realistic', 'cinematic'],
  摄影: ['photo', 'photography', 'studio', 'portrait'],
  动漫: ['anime', 'manga', 'illustration', '角色'],
  插画: ['illustration', 'drawing', 'anime'],
  三维: ['3d', 'cgi', 'render'],
  '3d': ['三维', 'cgi', 'render'],
  poster: ['海报', '广告', 'banner', 'cover'],
  cover: ['封面', 'poster', 'banner'],
  product: ['商品', '主图', '产品', 'e-commerce'],
  portrait: ['头像', '肖像', '人像', 'headshot'],
  character: ['角色', 'mascot', '角色卡'],
  ui: ['界面', '应用', 'interface', 'dashboard'],
  brand: ['品牌', 'logo', '标志'],
  typography: ['字体', '字标', 'wordmark'],
}

export function getTemplatePermissions(
  template: Pick<PromptTemplate, 'userId' | 'visibility' | 'submissionStatus'>,
  backendUser: BackendUser | null | undefined,
) {
  const isOwner = backendUser?.id === template.userId
  const isAdmin = backendUser?.role === 'admin'
  const canFavorite = Boolean(isOwner || isAdmin)
  const canManageDirectly = Boolean(
    isAdmin || (
      isOwner
      && template.submissionStatus !== 'submitted'
      && template.visibility !== 'public'
      && template.submissionStatus !== 'approved'
    ),
  )
  const canAdapt = Boolean(template.visibility === 'public' && !isAdmin)
  const canEdit = canManageDirectly || canAdapt
  const canDelete = canManageDirectly
  const canSubmit = Boolean(
    isOwner
    && !isAdmin
    && template.visibility !== 'public'
    && template.submissionStatus !== 'submitted'
    && template.submissionStatus !== 'approved'
  )
  const canReview = Boolean(isAdmin && template.submissionStatus === 'submitted')

  return {
    isOwner,
    isAdmin,
    canFavorite,
    canManageDirectly,
    canAdapt,
    canEdit,
    canDelete,
    canSubmit,
    canReview,
  }
}

export function getTemplateStatusMeta(template: Pick<PromptTemplate, 'visibility' | 'submissionStatus'>) {
  if (template.visibility === 'public') {
    return { kind: 'public' as const, shortLabel: '公共', longLabel: '公共模板' }
  }
  if (template.submissionStatus === 'submitted') {
    return { kind: 'submitted' as const, shortLabel: '待审核', longLabel: '待审核' }
  }
  if (template.submissionStatus === 'rejected') {
    return { kind: 'rejected' as const, shortLabel: '已驳回', longLabel: '已驳回' }
  }
  return { kind: 'private' as const, shortLabel: '私有', longLabel: '私有模板' }
}

export function getTemplateCoverFallback(template: Pick<PromptTemplate, 'externalCoverUrl' | 'exampleImages'>): string {
  return template.externalCoverUrl || template.exampleImages[0] || ''
}

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

export function normalizeSelectedProjectId(projectId?: string | null): string | null {
  return projectId && projectId !== UNASSIGNED_PROJECT_ID ? projectId : null
}

export function isApprovedPublicTemplate(
  template: Pick<PromptTemplate, 'visibility' | 'submissionStatus'>,
): boolean {
  return template.visibility === 'public' && template.submissionStatus === 'approved'
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
    channelId: draft.channelId || null,
    model: draft.model.trim(),
    linkedTaskIds: [...new Set(draft.linkedTaskIds ?? [])],
    coverImageId: draft.coverImageId || null,
    externalCoverUrl: draft.externalCoverUrl?.trim() || null,
    exampleImages: [...new Set((draft.exampleImages ?? []).map((url) => url.trim()).filter(Boolean))],
    recommendedChannelId: draft.recommendedChannelId || draft.channelId || null,
    recommendedApiMode: draft.recommendedApiMode || draft.apiMode,
    recommendedModel: draft.recommendedModel?.trim() || draft.model.trim(),
    isFavorite: Boolean(draft.isFavorite),
    sourceName: draft.sourceName?.trim() ?? '',
    sourceUrl: draft.sourceUrl?.trim() ?? '',
    sourceAuthor: draft.sourceAuthor?.trim() ?? '',
    licenseName: draft.licenseName?.trim() ?? '',
    projectId: normalizeSelectedProjectId(draft.projectId),
    formFields: (draft.formFields ?? [])
      .map((field) => ({
        ...field,
        key: field.key.trim(),
        label: field.label.trim() || field.key.trim(),
        defaultValue: field.defaultValue?.trim?.() ?? field.defaultValue ?? '',
        options: [...new Set((field.options ?? []).map((option) => option.trim()).filter(Boolean))],
        placeholder: field.placeholder?.trim?.() ?? field.placeholder ?? '',
        helpText: field.helpText?.trim?.() ?? field.helpText ?? '',
      }))
      .filter((field) => field.key),
    collections: [...new Set((draft.collections ?? []).map((item) => item.trim()).filter(Boolean))],
    isFeatured: Boolean(draft.isFeatured),
  }
}

export function filterTemplates(templates: PromptTemplate[], filters: TemplateFilters): PromptTemplate[] {
  const query = filters.query.trim().toLowerCase()
  const queryTokens = expandTemplateQuery(query)
  const category = filters.category
  const tag = filters.tag
  const collection = filters.collection

  return templates
    .filter((template) => {
      if (filters.favoriteOnly && !template.isFavorite) return false
      if (category && category !== ALL_TEMPLATE_CATEGORIES && template.category !== category) return false
      if (tag && tag !== ALL_TEMPLATE_TAGS && !template.tags.includes(tag)) return false
      if (collection && collection !== ALL_TEMPLATE_COLLECTIONS && !templateMatchesCollection(template, collection)) return false
      if (!query) return true

      const searchable = buildTemplateSearchText(template)
      return queryTokens.some((token) => textContainsTerm(searchable, token))
    })
    .sort((a, b) => {
      if (Number(b.isFavorite) !== Number(a.isFavorite)) return Number(b.isFavorite) - Number(a.isFavorite)
      if (query) {
        const delta = scoreTemplateForQuery(b, queryTokens) - scoreTemplateForQuery(a, queryTokens)
        if (delta) return delta
      }
      if (filters.sort === 'popular') {
        return (b.usageCount + b.favoriteCount * 2) - (a.usageCount + a.favoriteCount * 2) || b.updatedAt - a.updatedAt
      }
      if (filters.sort === 'quality') return b.qualityScore - a.qualityScore || b.updatedAt - a.updatedAt
      if (filters.sort === 'used') return (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.usageCount - a.usageCount
      return b.updatedAt - a.updatedAt
    })
}

function buildTemplateSearchText(template: PromptTemplate): string {
  const raw = buildTemplateRawSearchText(template)
  const semanticTerms = getTemplateSemanticTerms(template)
  return [raw, ...semanticTerms].join(' ').toLowerCase()
}

function buildTemplateRawSearchText(template: PromptTemplate): string {
  return [
    template.title,
    template.description,
    template.prompt,
    template.negativePrompt ?? '',
    template.category,
    template.tags.join(' '),
    template.model,
    template.recommendedModel ?? '',
    template.sourceName ?? '',
    template.sourceAuthor ?? '',
    template.licenseName ?? '',
    template.collections.join(' '),
    template.formFields.map((field) => `${field.label} ${field.key} ${field.helpText}`).join(' '),
  ].join(' ').toLowerCase()
}

function scoreTemplateForQuery(template: PromptTemplate, tokens: string[]): number {
  const title = template.title.toLowerCase()
  const tags = template.tags.join(' ').toLowerCase()
  const category = template.category.toLowerCase()
  const description = template.description.toLowerCase()
  const prompt = template.prompt.toLowerCase()
  const searchable = buildTemplateSearchText(template)
  let score = 0
  for (const token of tokens) {
    if (!token) continue
    if (textContainsTerm(title, token)) score += 12
    if (textContainsTerm(tags, token)) score += 8
    if (textContainsTerm(category, token)) score += 6
    if (textContainsTerm(description, token)) score += 4
    if (textContainsTerm(prompt, token)) score += 2
    if (textContainsTerm(searchable, token)) score += 1
  }
  score += Math.min(template.qualityScore ?? 0, 100) / 25
  score += Math.min(template.usageCount ?? 0, 50) / 10
  return score
}

function templateMatchesCollection(template: PromptTemplate, collectionId: string): boolean {
  const collection = TEMPLATE_COLLECTIONS.find((item) => item.id === collectionId)
  if (!collection) return true
  if (template.collections.includes(collectionId)) return true
  const searchable = buildTemplateRawSearchText(template)
  return collection.terms.some((term) => textContainsTerm(searchable, term))
}

function getTemplateSemanticTerms(template: PromptTemplate): string[] {
  const raw = buildTemplateRawSearchText(template)
  const terms = new Set<string>()
  for (const collection of TEMPLATE_COLLECTIONS) {
    if (collection.terms.some((term) => textContainsTerm(raw, term))) {
      terms.add(collection.label)
      for (const term of collection.terms) terms.add(term)
    }
  }
  for (const [key, values] of Object.entries(TEMPLATE_QUERY_DICTIONARY)) {
    if (textContainsTerm(raw, key)) {
      terms.add(key)
      for (const value of values) terms.add(value)
    }
  }
  return [...terms]
}

function textContainsTerm(text: string, term: string): boolean {
  const normalizedTerm = term.trim().toLowerCase()
  if (!normalizedTerm) return false
  if (/^[a-z0-9][a-z0-9+#.-]*$/.test(normalizedTerm) && normalizedTerm.length <= 3) {
    const escaped = normalizedTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text)
  }
  return text.includes(normalizedTerm)
}

export function getTemplateCollectionCounts(templates: PromptTemplate[]): Array<{ id: string; label: string; count: number }> {
  return TEMPLATE_COLLECTIONS.map((collection) => ({
    id: collection.id,
    label: collection.label,
    count: templates.filter((template) => templateMatchesCollection(template, collection.id)).length,
  })).filter((item) => item.count > 0)
}

function expandTemplateQuery(query: string): string[] {
  if (!query) return []
  const tokens = new Set<string>([query])
  for (const part of query.split(/[\s,，、/|]+/).filter(Boolean)) {
    tokens.add(part)
    for (const value of TEMPLATE_QUERY_DICTIONARY[part] ?? []) tokens.add(value.toLowerCase())
  }
  for (const [key, values] of Object.entries(TEMPLATE_QUERY_DICTIONARY)) {
    if (query.includes(key)) {
      for (const value of values) tokens.add(value.toLowerCase())
    }
  }
  return [...tokens].filter(Boolean)
}

export function getTemplateCoverImageIds(templates: PromptTemplate[]): string[] {
  return templates
    .map((template) => template.coverImageId)
    .filter((id): id is string => Boolean(id))
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

export interface TemplateVariableDefinition {
  name: string
  defaultValue: string
  source: 'mustache' | 'argument' | 'placeholder' | 'form'
  type: 'text' | 'textarea' | 'select' | 'color' | 'number' | 'image'
  options: string[]
  required: boolean
  description: string
  example: string
}

function parseArgumentAttributes(value: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s}]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value))) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? ''
  }
  return attrs
}

function normalizeVariableType(value: string | undefined, name: string, defaultValue: string): TemplateVariableDefinition['type'] {
  const raw = (value || '').toLowerCase()
  if (['textarea', 'longtext', 'long_text', 'multiline'].includes(raw)) return 'textarea'
  if (['select', 'enum', 'choice'].includes(raw)) return 'select'
  if (['color', 'colour'].includes(raw)) return 'color'
  if (['number', 'int', 'integer', 'float'].includes(raw)) return 'number'
  if (['image', 'file', 'photo'].includes(raw)) return 'image'
  const hint = `${name} ${defaultValue}`.toLowerCase()
  if (/颜色|色值|主色|color|colour|hex/.test(hint)) return 'color'
  if (/数量|个数|宽度|高度|比例|number|\bcount\b|width|height|ratio/.test(hint)) return 'number'
  if (/图片|图像|logo|照片|image|photo|picture/.test(hint)) return 'image'
  if (/背景|场景|描述|concept|scene|background|description/.test(hint) || defaultValue.length > 42) return 'textarea'
  return 'text'
}

function parseVariableOptions(attrs: Record<string, string>): string[] {
  const raw = attrs.options || attrs.choices || attrs.values || ''
  return raw
    .split(/[|,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function makeVariableDefinition(
  name: string,
  source: TemplateVariableDefinition['source'],
  attrs: Record<string, string> = {},
): TemplateVariableDefinition {
  const defaultValue = attrs.default?.trim() ?? attrs.value?.trim() ?? ''
  const options = parseVariableOptions(attrs)
  const type = options.length ? 'select' : normalizeVariableType(attrs.type, name, defaultValue)
  const required = !['false', '0', 'no'].includes((attrs.required ?? '').toLowerCase())
  return {
    name,
    defaultValue,
    source,
    type,
    options,
    required,
    description: (attrs.description || attrs.desc || attrs.help || '').trim(),
    example: (attrs.example || attrs.placeholder || '').trim(),
  }
}

export function extractTemplateVariableDefinitions(...texts: Array<string | undefined | null>): TemplateVariableDefinition[] {
  const seen = new Set<string>()
  const vars: TemplateVariableDefinition[] = []
  const mustachePattern = /\{\{\s*([^{}]+?)\s*\}\}/g
  const argumentPattern = /\{argument\s+([^{}]+)\}/g
  const placeholderPattern = /\[([^\]\n]{2,48})\]/g

  for (const text of texts) {
    if (!text) continue
    mustachePattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = mustachePattern.exec(text))) {
      const name = match[1].trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      vars.push(makeVariableDefinition(name, 'mustache'))
    }

    argumentPattern.lastIndex = 0
    while ((match = argumentPattern.exec(text))) {
      const attrs = parseArgumentAttributes(match[1])
      const name = (attrs.name || attrs.label || '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      vars.push(makeVariableDefinition(name, 'argument', attrs))
    }

    placeholderPattern.lastIndex = 0
    while ((match = placeholderPattern.exec(text))) {
      const name = match[1].trim()
      if (!name || /^\d+$/.test(name) || seen.has(name)) continue
      seen.add(name)
      vars.push(makeVariableDefinition(name, 'placeholder'))
    }
  }

  return vars
}

export function formFieldsToVariableDefinitions(fields: TemplateFormField[]): TemplateVariableDefinition[] {
  return fields
    .map((field) => ({
      name: field.key.trim(),
      defaultValue: field.defaultValue ?? '',
      source: 'form' as const,
      type: field.type,
      options: field.options ?? [],
      required: field.required,
      description: field.helpText ?? '',
      example: field.placeholder ?? '',
    }))
    .filter((field) => field.name)
}

export function extractTemplateVariables(...texts: Array<string | undefined | null>): string[] {
  return extractTemplateVariableDefinitions(...texts).map((item) => item.name)
}

function fillTemplateVariables(text: string, values: Record<string, string>): string {
  return text
    .replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, name: string) => values[name.trim()]?.trim() ?? '')
    .replace(/\{argument\s+([^{}]+)\}/g, (placeholder: string, attrsText: string) => {
      const attrs = parseArgumentAttributes(attrsText)
      const name = (attrs.name || attrs.label || '').trim()
      if (!name) return placeholder
      return values[name]?.trim() || attrs.default?.trim() || ''
    })
    .replace(/\[([^\]\n]{2,48})\]/g, (placeholder: string, name: string) => {
      const key = name.trim()
      return values[key]?.trim() || placeholder
    })
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
