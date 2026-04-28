import { describe, expect, it } from 'vitest'
import { DEFAULT_PARAMS } from '../types'
import type { PromptTemplate } from '../types'
import {
  ALL_TEMPLATE_CATEGORIES,
  duplicateTemplateRecord,
  filterTemplates,
  getTemplateCategories,
  getTemplateTags,
  normalizeTemplateDraft,
  normalizeTemplateTags,
  extractTemplateVariables,
  composeTemplatePrompt,
} from './templateUtils'

function template(overrides: Partial<PromptTemplate> = {}): PromptTemplate {
  return {
    id: 'template-a',
    userId: null,
    title: 'Product hero',
    description: 'White background product render',
    prompt: 'A clean product photo',
    tags: ['product', 'white'],
    category: 'commerce',
    params: { ...DEFAULT_PARAMS },
    apiMode: 'images',
    model: 'gpt-image-2',
    coverImageId: null,
    linkedTaskIds: [],
    isFavorite: false,
    version: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('template utilities', () => {
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
      coverImageId: '',
      linkedTaskIds: ['task-a', 'task-a'],
    })

    expect(draft.title).toBe('A cinematic portrait with so...')
    expect(draft.description).toBe('useful')
    expect(draft.tags).toEqual(['portrait'])
    expect(draft.category).toBe('people')
    expect(draft.model).toBe('gpt-5.5')
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
    }).map((item) => item.id)).toEqual(['b'])

    expect(filterTemplates(templates, {
      query: '',
      category: 'commerce',
      tag: 'product',
      favoriteOnly: true,
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
})
