import { useMemo } from 'react'
import { useStore } from '../store'

export default function GenerationQueueStatus() {
  const queueStats = useStore((s) => s.queueStats)
  const tasks = useStore((s) => s.tasks)

  const hasActiveLocalTask = useMemo(
    () => tasks.some((task) => task.status === 'queued' || task.status === 'running'),
    [tasks],
  )

  if (!queueStats || (!hasActiveLocalTask && queueStats.queuedCount === 0 && queueStats.runningCount === 0)) {
    return null
  }

  return (
    <section className="mb-4 rounded-xl border border-gray-200 bg-white/80 p-3 dark:border-white/[0.08] dark:bg-gray-900/80">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-gray-700 dark:text-gray-200">生成队列</h2>
        <span className="text-xs text-gray-400 dark:text-gray-500">并行 worker {queueStats.workerCount}</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-4">
        <Metric label="全站排队" value={queueStats.queuedCount} tone="amber" />
        <Metric label="全站执行中" value={queueStats.runningCount} tone="blue" />
        <Metric label="我的排队" value={queueStats.yourQueuedCount} tone="amber" />
        <Metric label="我的执行中" value={queueStats.yourRunningCount} tone="blue" />
      </div>
    </section>
  )
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'amber' | 'blue'
}) {
  const className =
    tone === 'amber'
      ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-200'
      : 'bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-200'

  return (
    <div className={`rounded-lg px-3 py-2 text-sm ${className}`}>
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-xs opacity-80">{label}</div>
    </div>
  )
}
