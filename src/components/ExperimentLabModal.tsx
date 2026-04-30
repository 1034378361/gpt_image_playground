import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { submitTaskMatrix } from '../storeBackend'
import { normalizeImageSize } from '../lib/size'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

interface Props {
  open: boolean
  onClose: () => void
}

const SIZE_OPTIONS = ['auto', '1024x1024', '1536x1024', '1024x1536', '2048x2048']
const QUALITY_OPTIONS: Array<'auto' | 'low' | 'medium' | 'high'> = ['auto', 'low', 'medium', 'high']

export default function ExperimentLabModal({ open, onClose }: Props) {
  const channels = useStore((s) => s.channels)
  const settings = useStore((s) => s.settings)
  const params = useStore((s) => s.params)
  const showToast = useStore((s) => s.showToast)
  const [selectedTargets, setSelectedTargets] = useState<string[]>([])
  const [selectedSizes, setSelectedSizes] = useState<string[]>([])
  const [selectedQualities, setSelectedQualities] = useState<Array<'auto' | 'low' | 'medium' | 'high'>>([])
  const [submitting, setSubmitting] = useState(false)

  useCloseOnEscape(open, onClose)

  const targets = useMemo(
    () =>
      channels.flatMap((channel) =>
        channel.models
          .filter((model) => model.enabled)
          .map((model) => ({
            key: `${channel.id}::${model.id}::${model.apiMode}`,
            channelId: channel.id,
            channelName: channel.name,
            model: model.id,
            modelLabel: model.label || model.id,
            apiMode: model.apiMode,
          })),
      ),
    [channels],
  )

  useEffect(() => {
    if (!open) return
    const currentKey = `${settings.channelId}::${settings.model}::${settings.apiMode}`
    setSelectedTargets(targets.some((target) => target.key === currentKey) ? [currentKey] : targets.slice(0, 1).map((target) => target.key))
    setSelectedSizes([normalizeImageSize(params.size) || 'auto'])
    setSelectedQualities([params.quality])
  }, [open, params.quality, params.size, settings.apiMode, settings.channelId, settings.model, targets])

  if (!open) return null

  const toggleItem = <T extends string>(items: T[], value: T, setter: (value: T[]) => void) => {
    setter(items.includes(value) ? items.filter((item) => item !== value) : [...items, value])
  }

  const combinationCount = selectedTargets.length * selectedSizes.length * selectedQualities.length
  const tooMany = combinationCount > 12

  const handleSubmit = async () => {
    if (!selectedTargets.length) {
      showToast('至少选择一个渠道 / 模型组合', 'error')
      return
    }
    if (!selectedSizes.length || !selectedQualities.length) {
      showToast('至少选择一个尺寸和一个质量档位', 'error')
      return
    }
    if (tooMany) {
      showToast('组合数量请控制在 12 组以内', 'error')
      return
    }
    const variants = selectedTargets.flatMap((key) => {
      const target = targets.find((item) => item.key === key)
      if (!target) return []
      return selectedSizes.flatMap((size) =>
        selectedQualities.map((quality) => ({
          channelId: target.channelId,
          model: target.model,
          apiMode: target.apiMode,
          params: { size, quality },
          variationLabel: `${target.channelName} · ${target.modelLabel} · ${size} · ${quality}`,
        })),
      )
    })
    setSubmitting(true)
    try {
      await submitTaskMatrix(variants)
      onClose()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-[94] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative z-10 w-full max-w-3xl rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">A/B 对比实验室</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">同一条提示词，一次并发比较不同渠道、模型、尺寸和质量。</p>
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

        <div className="grid gap-4 md:grid-cols-3">
          <section className="rounded-2xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <h4 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-100">渠道 / 模型</h4>
            <div className="max-h-64 space-y-2 overflow-y-auto">
              {targets.map((target) => (
                <label key={target.key} className="flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={selectedTargets.includes(target.key)}
                    onChange={() => toggleItem(selectedTargets, target.key, setSelectedTargets)}
                  />
                  <span className="min-w-0 truncate">{target.channelName} · {target.modelLabel}</span>
                </label>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <h4 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-100">尺寸</h4>
            <div className="space-y-2">
              {SIZE_OPTIONS.map((size) => (
                <label key={size} className="flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
                  <input type="checkbox" checked={selectedSizes.includes(size)} onChange={() => toggleItem(selectedSizes, size, setSelectedSizes)} />
                  {size}
                </label>
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <h4 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-100">质量</h4>
            <div className="space-y-2">
              {QUALITY_OPTIONS.map((quality) => (
                <label key={quality} className="flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={selectedQualities.includes(quality)}
                    onChange={() => toggleItem(selectedQualities, quality, setSelectedQualities)}
                  />
                  {quality}
                </label>
              ))}
            </div>
          </section>
        </div>

        <div className={`mt-4 rounded-2xl border px-4 py-3 text-sm ${
          tooMany
            ? 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200'
            : 'border-gray-200 bg-gray-50 text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300'
        }`}>
          本次将提交 <span className="font-semibold">{combinationCount}</span> 组实验。
          {tooMany && <span className="ml-1">为了避免一次性过载，请控制在 12 组以内。</span>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting || tooMany || !combinationCount}
            className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '提交中...' : '开始实验'}
          </button>
        </div>
      </div>
    </div>
  )
}
