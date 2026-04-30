import { useEffect, useMemo, useState } from 'react'
import type { OpenPromptPreview, OpenPromptPreviewItem } from '../types'
import { useStore } from '../store'
import { importOpenPromptLibrary } from '../storeBackend'
import {
  previewOpenPromptLibraryTemplates,
  type OpenPromptLibrarySourceId,
} from '../lib/backendApi'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import Select from './Select'

interface Props {
  open: boolean
  source: OpenPromptLibrarySourceId
  onClose: () => void
  limit?: number
}

type DuplicateFilter = 'new' | 'all' | 'duplicate'
type QualityFilter = 'all' | 'high' | 'solid'

export default function OpenPromptImportPreviewModal({ open, source, onClose, limit = 0 }: Props) {
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const [preview, setPreview] = useState<OpenPromptPreview | null>(null)
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [duplicateFilter, setDuplicateFilter] = useState<DuplicateFilter>('new')
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>('all')
  const [loading, setLoading] = useState(false)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')

  useCloseOnEscape(open, onClose)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    setError('')
    setPreview(null)
    setSelectedKeys(new Set())
    void previewOpenPromptLibraryTemplates(settings, source, limit)
      .then((result) => {
        if (cancelled) return
        setPreview(result)
        setSelectedKeys(new Set(result.items.filter((item) => !item.isDuplicate).map((item) => item.key)))
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [limit, open, settings, source])

  const visibleItems = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return (preview?.items ?? []).filter((item) => {
      if (duplicateFilter === 'new' && item.isDuplicate) return false
      if (duplicateFilter === 'duplicate' && !item.isDuplicate) return false
      if (qualityFilter === 'high' && item.qualityScore < 70) return false
      if (qualityFilter === 'solid' && item.qualityScore < 50) return false
      if (!normalizedQuery) return true
      const searchable = [
        item.title,
        item.prompt,
        item.category,
        item.tags.join(' '),
        item.sourceAuthor,
      ].join(' ').toLowerCase()
      return searchable.includes(normalizedQuery)
    })
  }, [duplicateFilter, preview?.items, qualityFilter, query])

  if (!open) return null

  const toggleItem = (key: string) => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const selectVisible = (items: OpenPromptPreviewItem[]) => {
    setSelectedKeys((current) => {
      const next = new Set(current)
      for (const item of items) next.add(item.key)
      return next
    })
  }

  const selectNewOnly = () => {
    setSelectedKeys(new Set((preview?.items ?? []).filter((item) => !item.isDuplicate).map((item) => item.key)))
  }

  const selectHighQualityNewOnly = () => {
    setSelectedKeys(
      new Set(
        (preview?.items ?? [])
          .filter((item) => !item.isDuplicate && item.qualityScore >= 70)
          .map((item) => item.key),
      ),
    )
  }

  const startImport = async () => {
    if (!preview || !selectedKeys.size) return
    setImporting(true)
    try {
      await importOpenPromptLibrary(source, 0, [...selectedKeys])
      onClose()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative z-10 flex max-h-[88vh] w-full max-w-5xl flex-col rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-gray-800 dark:text-gray-100">
              预览开源模板导入
            </h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {preview ? `${preview.label} · ${preview.licenseName}` : '正在读取远端模板源'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="mb-3 grid gap-2 md:grid-cols-[1fr_9rem_9rem_auto]">
          <div className="relative">
            <svg
              className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400 dark:text-gray-500"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="按标题、提示词、标签、作者筛选"
              className="w-full rounded-xl border border-gray-200 bg-white py-2.5 pl-10 pr-3 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-500/20 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200"
            />
          </div>
          <Select
            value={duplicateFilter}
            onChange={(value) => setDuplicateFilter(value as DuplicateFilter)}
            options={[
              { label: '仅新模板', value: 'new' },
              { label: '全部模板', value: 'all' },
              { label: '仅重复项', value: 'duplicate' },
            ]}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]"
          />
          <Select
            value={qualityFilter}
            onChange={(value) => setQualityFilter(value as QualityFilter)}
            options={[
              { label: '全部质量', value: 'all' },
              { label: '70+ 高分', value: 'high' },
              { label: '50+ 可用', value: 'solid' },
            ]}
            className="rounded-xl border border-gray-200 bg-white px-3 py-2.5 text-sm dark:border-white/[0.08] dark:bg-white/[0.03]"
          />
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!visibleItems.length}
              onClick={() => selectVisible(visibleItems)}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.08]"
            >
              全选当前
            </button>
            <button
              type="button"
              disabled={!preview?.items.length}
              onClick={selectNewOnly}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.08]"
            >
              仅选新
            </button>
            <button
              type="button"
              disabled={!preview?.items.length}
              onClick={selectHighQualityNewOnly}
              className="rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 transition hover:bg-gray-50 disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.08]"
            >
              仅选 70+ 新模板
            </button>
          </div>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
          <span>已选 {selectedKeys.size}</span>
          <span>当前显示 {visibleItems.length}</span>
          {preview && <span>远端总量 {preview.total}</span>}
          {preview && <span>新模板 {preview.newCount}</span>}
          {preview && <span>重复 {preview.duplicateCount}</span>}
          {preview && <span>70+ {preview.highQualityCount}</span>}
          {preview && <span>70+ 新模板 {preview.highQualityNewCount}</span>}
          <button
            type="button"
            onClick={() => setSelectedKeys(new Set())}
            disabled={!selectedKeys.size}
            className="ml-auto rounded-lg px-2 py-1 text-gray-500 transition hover:bg-gray-100 disabled:opacity-40 dark:text-gray-400 dark:hover:bg-white/[0.06]"
          >
            清空选择
          </button>
        </div>

        {preview?.truncated && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50/80 px-3 py-2 text-xs text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200">
            当前只加载了 {preview.loaded} / {preview.total} 条远端模板，建议继续扩大读取范围后再做全量导入。
          </div>
        )}

        <div className="min-h-[20rem] flex-1 overflow-y-auto rounded-2xl border border-gray-200/70 bg-gray-50/70 p-2 dark:border-white/[0.08] dark:bg-white/[0.03]">
          {loading ? (
            <div className="flex h-80 items-center justify-center text-sm text-gray-500 dark:text-gray-400">
              正在解析远端模板...
            </div>
          ) : error ? (
            <div className="flex h-80 items-center justify-center px-6 text-center text-sm text-red-500">
              {error}
            </div>
          ) : visibleItems.length ? (
            <div className="grid gap-2 md:grid-cols-2">
              {visibleItems.map((item) => (
                <label
                  key={item.key}
                  className={`flex cursor-pointer gap-3 rounded-xl border p-3 transition ${
                    selectedKeys.has(item.key)
                      ? 'border-blue-300 bg-blue-50/80 dark:border-blue-400/40 dark:bg-blue-500/10'
                      : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-white/[0.08] dark:bg-gray-900/60 dark:hover:bg-white/[0.05]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(item.key)}
                    onChange={() => toggleItem(item.key)}
                    className="mt-1 h-4 w-4 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                  />
                  {item.image ? (
                    <img
                      src={item.image}
                      alt=""
                      className="h-20 w-20 flex-shrink-0 rounded-lg bg-gray-100 object-cover dark:bg-white/[0.06]"
                      loading="lazy"
                    />
                  ) : (
                    <div className="h-20 w-20 flex-shrink-0 rounded-lg bg-gray-100 dark:bg-white/[0.06]" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{item.title}</p>
                      {item.isDuplicate && (
                        <span className="flex-shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-400/15 dark:text-amber-200">
                          已存在
                        </span>
                      )}
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500 dark:text-gray-400">{item.prompt}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-gray-500 dark:text-gray-400">
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 dark:bg-white/[0.06]">
                        {item.category || 'inspiration'}
                      </span>
                      <span className="rounded-full bg-gray-100 px-2 py-0.5 dark:bg-white/[0.06]">
                        质量 {Math.round(item.qualityScore)}
                      </span>
                      {item.tags.slice(0, 3).map((tag) => (
                        <span key={tag} className="rounded-full bg-gray-100 px-2 py-0.5 dark:bg-white/[0.06]">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <div className="flex h-80 items-center justify-center text-sm text-gray-500 dark:text-gray-400">
              没有匹配的模板
            </div>
          )}
        </div>

        <div className="mt-4 flex gap-2 border-t border-gray-100 pt-4 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void startImport()}
            disabled={loading || importing || !selectedKeys.size}
            className="flex-1 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {importing ? '导入中' : `导入已选 ${selectedKeys.size}`}
          </button>
        </div>
      </div>
    </div>
  )
}
