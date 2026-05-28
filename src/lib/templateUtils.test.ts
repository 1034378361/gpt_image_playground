import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import type { BackendUser, PromptTemplate } from '../types'
import {
  ALL_TEMPLATE_CATEGORIES,
  ALL_TEMPLATE_COLLECTIONS,
  composeTemplatePrompt,
  duplicateTemplateRecord,
  extractTemplateVariableDefinitions,
  extractTemplateVariables,
  filterTemplates,
  getTemplateCategories,
  getTemplateCollectionCounts,
  getTemplateCoverFallback,
  getTemplatePermissions,
  getTemplateStatusMeta,
  getTemplateTags,
  normalizeTemplateDraft,
  normalizeTemplateTags,
} from './templateUtils'

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'template-a',
    userId: null,
    projectId: null,
    title: 'Product hero',
    description: 'White background product render',
    prompt: 'A clean product photo',
    negativePrompt: undefined,
    tags: ['product', 'white'],
    category: 'commerce',
    params: { ...DEFAULT_PARAMS },
    channelId: null,
    apiMode: 'images',
    model: 'gpt-image-2',
    coverImageId: null,
    externalCoverUrl: null,
    exampleImages: [],
    cachedExternalCoverUrl: null,
    cachedExampleImages: [],
    recommendedChannelId: null,
    recommendedApiMode: null,
    recommendedModel: '',
    linkedTaskIds: [],
    isFavorite: false,
    sourceName: '',
    sourceUrl: '',
    sourceAuthor: '',
    licenseName: '',
    formFields: [],
    collections: [],
    isFeatured: false,
    visibility: 'private',
    submissionStatus: 'draft',
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    favoriteCount: 0,
    usageCount: 0,
    successCount: 0,
    failureCount: 0,
    ratingCount: 0,
    averageRating: 0,
    lastUsedAt: null,
    qualityScore: 0,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

function user(overrides: Partial<BackendUser> = {}): BackendUser {
  return {
    id: 'user-a',
    username: 'alice',
    role: 'user',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('template utilities', () => {
  it('returns template permissions for owner, public viewer, and admin reviewer cases', () => {
    expect(getTemplatePermissions(template(), user())).toMatchObject({
      isOwner: false,
      isAdmin: false,
      canFavorite: false,
      canEdit: false,
      canDelete: false,
      canSubmit: false,
      canReview: false,
    })

    expect(getTemplatePermissions(template({ userId: 'user-a' }), user())).toMatchObject({
      isOwner: true,
      canFavorite: true,
      canEdit: true,
      canDelete: true,
      canSubmit: true,
      canReview: false,
    })

    expect(getTemplatePermissions(template({ visibility: 'public', submissionStatus: 'approved' }), user())).toMatchObject({
      canAdapt: true,
      canEdit: true,
      canDelete: false,
      canSubmit: false,
    })

    expect(getTemplatePermissions(template({ submissionStatus: 'submitted' }), user({ role: 'admin' }))).toMatchObject({
      isAdmin: true,
      canFavorite: true,
      canReview: true,
      canEdit: true,
      canDelete: true,
    })

    expect(getTemplatePermissions(template({ submissionStatus: 'submitted' }), user({ role: 'reviewer' }))).toMatchObject({
      isAdmin: false,
      canReview: true,
      canEdit: false,
      canDelete: false,
      canSubmit: false,
    })

    expect(getTemplatePermissions(template(), user({ role: 'reviewer' }))).toMatchObject({
      canReview: false,
      canEdit: false,
      canDelete: false,
    })

    expect(getTemplatePermissions(template({ visibility: 'public', submissionStatus: 'approved' }), user({ role: 'reviewer' }))).toMatchObject({
      canReview: false,
      canEdit: true,
      canDelete: false,
    })
  })

  it('returns template status metadata and cover fallback in a stable order', () => {
    expect(getTemplateStatusMeta(template({ visibility: 'public', submissionStatus: 'approved' }))).toEqual({
      kind: 'public',
      shortLabel: '公共',
      longLabel: '公共模板',
    })
    expect(getTemplateStatusMeta(template({ submissionStatus: 'submitted' }))).toEqual({
      kind: 'submitted',
      shortLabel: '待审核',
      longLabel: '待审核',
    })
    expect(getTemplateStatusMeta(template({ submissionStatus: 'rejected' }))).toEqual({
      kind: 'rejected',
      shortLabel: '已驳回',
      longLabel: '已驳回',
    })
    expect(getTemplateStatusMeta(template())).toEqual({
      kind: 'private',
      shortLabel: '私有',
      longLabel: '私有模板',
    })

    expect(getTemplateCoverFallback(template({ externalCoverUrl: 'https://example.test/cover.png', exampleImages: ['https://example.test/fallback.png'] }))).toBe(
      'https://example.test/cover.png',
    )
    expect(getTemplateCoverFallback(template({ externalCoverUrl: null, exampleImages: ['https://example.test/fallback.png'] }))).toBe(
      'https://example.test/fallback.png',
    )
    expect(getTemplateCoverFallback(template({
      externalCoverUrl: 'https://example.test/cover.png',
      exampleImages: ['https://example.test/fallback.png'],
      cachedExternalCoverUrl: '/api/assets/remote-cache/templates/template-a?url=cover',
      cachedExampleImages: ['/api/assets/remote-cache/templates/template-a?url=fallback'],
    }))).toBe('/api/assets/remote-cache/templates/template-a?url=cover')
    expect(getTemplateCoverFallback(template({
      externalCoverUrl: null,
      exampleImages: ['https://example.test/fallback.png'],
      cachedExampleImages: ['/api/assets/remote-cache/templates/template-a?url=fallback'],
    }))).toBe('/api/assets/remote-cache/templates/template-a?url=fallback')
    expect(getTemplateCoverFallback(template())).toBe('')
  })

  it('normalizes template tags and removes duplicates case-insensitively', () => {
    expect(normalizeTemplateTags(' product, Product,  portrait ,, 白底 ')).toEqual([
      'product',
      'portrait',
      '白底',
    ])
  })

  it('normalizes a draft with title fallback and linked task de-duplication', () => {
    const draft = normalizeTemplateDraft({
      title: '',
      description: '  useful  ',
      prompt: '  A cinematic portrait with soft light  ',
      tags: [' portrait ', 'portrait'],
      category: ' people ',
      params: { ...DEFAULT_PARAMS },
      apiMode: 'responses',
      model: ' gpt-5.5 ',
      projectId: '__unassigned__',
      coverImageId: '',
      linkedTaskIds: ['task-a', 'task-a'],
    })

    expect(draft.title).toBe('A cinematic portrait with so...')
    expect(draft.description).toBe('useful')
    expect(draft.tags).toEqual(['portrait'])
    expect(draft.category).toBe('people')
    expect(draft.model).toBe('gpt-5.5')
    expect(draft.projectId).toBeNull()
    expect(draft.coverImageId).toBeNull()
    expect(draft.linkedTaskIds).toEqual(['task-a'])
  })

  it('filters templates by query, category, tag, and favorite state', () => {
    const templates = [
      template({ id: 'a', title: 'Product hero', tags: ['product'], category: 'commerce', isFavorite: true, updatedAt: 2 }),
      template({ id: 'b', title: 'Portrait', prompt: 'dramatic studio face', tags: ['portrait'], category: 'people', updatedAt: 3 }),
    ]

    expect(filterTemplates(templates, {
      query: 'studio',
      category: ALL_TEMPLATE_CATEGORIES,
      tag: '__all__',
      favoriteOnly: false,
      scope: 'all',
      sort: 'updated',
      collection: ALL_TEMPLATE_COLLECTIONS,
    }).map((item) => item.id)).toEqual(['b'])

    expect(filterTemplates(templates, {
      query: '',
      category: 'commerce',
      tag: 'product',
      favoriteOnly: true,
      scope: 'all',
      sort: 'updated',
      collection: ALL_TEMPLATE_COLLECTIONS,
    }).map((item) => item.id)).toEqual(['a'])
  })

  it('collects categories and tags for filter controls', () => {
    const templates = [
      template({ category: 'commerce', tags: ['product', 'white'] }),
      template({ id: 'b', category: 'people', tags: ['portrait', 'white'] }),
    ]

    expect(getTemplateCategories(templates)).toEqual(['commerce', 'people'])
    expect(getTemplateTags(templates)).toEqual(['portrait', 'product', 'white'])
  })

  it('duplicates templates without carrying linked tasks or favorite state', () => {
    const copy = duplicateTemplateRecord(
      template({ linkedTaskIds: ['task-a'], isFavorite: true, coverImageId: 'image-a' }),
      'copy-id',
      10,
    )

    expect(copy.id).toBe('copy-id')
    expect(copy.title).toBe('Product hero 副本')
    expect(copy.linkedTaskIds).toEqual([])
    expect(copy.isFavorite).toBe(false)
    expect(copy.coverImageId).toBe('image-a')
    expect(copy.version).toBe(1)
    expect(copy.createdAt).toBe(10)
  })

  it('extracts and fills template variables including negative prompt', () => {
    const t = template({
      prompt: 'A {{product_name}} on {{background}}',
      negativePrompt: 'no {{background}}, no blur',
    })

    expect(extractTemplateVariables(t.prompt, t.negativePrompt)).toEqual(['product_name', 'background'])
    expect(composeTemplatePrompt(t, { product_name: 'watch', background: 'marble' })).toBe(
      'A watch on marble\n\nNegative prompt: no marble, no blur',
    )
  })

  it('extracts and fills Rova-style argument variables with defaults', () => {
    const t = template({
      prompt: 'A bottle labeled {argument name="brand label" default="N°5"} on {{surface}}',
    })

    expect(extractTemplateVariables(t.prompt)).toEqual(['surface', 'brand label'])
    expect(composeTemplatePrompt(t, { surface: 'black marble' })).toBe('A bottle labeled N°5 on black marble')
    expect(composeTemplatePrompt(t, { 'brand label': 'ACME', surface: 'glass' })).toBe('A bottle labeled ACME on glass')
  })

  it('extracts bracket placeholders and expands semantic query terms', () => {
    const t = template({
      prompt: 'A premium [LOGO_NAME] door handle with [background]',
      tags: ['product'],
      category: 'commerce',
    })

    expect(extractTemplateVariables(t.prompt)).toEqual(['LOGO_NAME', 'background'])
    expect(composeTemplatePrompt(t, { LOGO_NAME: 'Acme', background: 'walnut door' })).toBe(
      'A premium Acme door handle with walnut door',
    )
    expect(filterTemplates([t], {
      query: '商品',
      category: ALL_TEMPLATE_CATEGORIES,
      tag: '__all__',
      favoriteOnly: false,
      scope: 'all',
      sort: 'quality',
      collection: ALL_TEMPLATE_COLLECTIONS,
    }).map((item) => item.id)).toEqual(['template-a'])
  })

  it('extracts typed argument variable definitions', () => {
    const variables = extractTemplateVariableDefinitions(
      'A {argument name="palette" type="select" options="red|blue" required="false" description="主色" example="red"} background',
    )

    expect(variables[0]).toMatchObject({
      name: 'palette',
      type: 'select',
      options: ['red', 'blue'],
      required: false,
      description: '主色',
      example: 'red',
    })
  })

  it('filters by semantic collections and expanded search terms', () => {
    const templates = [
      template({ id: 'a', title: 'Clean packshot', prompt: 'studio product bottle render', tags: ['product'], category: 'commerce' }),
      template({ id: 'b', title: 'Wordmark study', description: 'identity system', prompt: 'typography logo exploration', tags: ['brand'], category: 'identity' }),
    ]

    expect(getTemplateCollectionCounts(templates).map((item) => item.id)).toContain('product-hero')
    expect(filterTemplates(templates, {
      query: '字标',
      category: ALL_TEMPLATE_CATEGORIES,
      tag: '__all__',
      favoriteOnly: false,
      scope: 'all',
      sort: 'quality',
      collection: ALL_TEMPLATE_COLLECTIONS,
    }).map((item) => item.id)).toEqual(['b'])
    expect(filterTemplates(templates, {
      query: '',
      category: ALL_TEMPLATE_CATEGORIES,
      tag: '__all__',
      favoriteOnly: false,
      scope: 'all',
      sort: 'quality',
      collection: 'product-hero',
    }).map((item) => item.id)).toEqual(['a'])
  })
})
