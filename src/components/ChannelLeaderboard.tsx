import { useStore } from '../store'
import { compatibilityStatusLabel, healthBadgeClass, healthStatusLabel } from '../lib/channelHealth'

function formatElapsed(value?: number | null) {
  if (value == null) return '-'
  const seconds = Math.max(0, Math.round(value / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export default function ChannelLeaderboard() {
  const items = useStore((s) => s.channelLeaderboard)
  if (!items.length) return null

  return (
    <section className="mb-4 rounded-xl border border-gray-200 bg-white/80 p-3 dark:border-white/[0.08] dark:bg-gray-900/80">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">渠道效果榜</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">按成功生成排序</span>
      </div>
      <div className="flex gap-2 overflow-x-auto hide-scrollbar">
        {items.slice(0, 6).map((item) => (
          <div
            key={`${item.channelId}-${item.model}-${item.apiMode}`}
            className="min-w-[13rem] rounded-lg border border-gray-200/70 bg-gray-50 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.03]"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="min-w-0 truncate text-sm font-medium text-gray-700 dark:text-gray-200">{item.channelName}</p>
              <span className={`rounded-full px-2 py-0.5 text-[10px] ${healthBadgeClass(item.healthStatus)}`}>
                {healthStatusLabel(item.healthStatus)}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-gray-500 dark:text-gray-400">{item.model || '-'}</p>
            <div className="mt-2 grid grid-cols-3 gap-1 text-center text-[11px] text-gray-500 dark:text-gray-400">
              <span className="rounded bg-white px-1 py-1 dark:bg-white/[0.05]">成功 {item.successCount}</span>
              <span className="rounded bg-white px-1 py-1 dark:bg-white/[0.05]">{Math.round(item.successRate * 100)}%</span>
              <span className="rounded bg-white px-1 py-1 dark:bg-white/[0.05]">{formatElapsed(item.averageElapsed)}</span>
            </div>
            <p className="mt-2 truncate text-[11px] text-gray-400 dark:text-gray-500">
              {compatibilityStatusLabel(item.compatibilityStatus)} · 共 {item.totalCount} 次
            </p>
          </div>
        ))}
      </div>
    </section>
  )
}
