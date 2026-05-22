import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useVersionCheck } from '../hooks/useVersionCheck'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import {
  compatibilityBadgeClass,
  compatibilityStatusLabel,
  healthBadgeClass,
  healthStatusLabel,
} from '../lib/channelHealth'
import { canOpenSettings, roleLabel } from '../lib/roles'

const HelpModal = lazy(() => import('./HelpModal'))
const REPO_URL = 'https://github.com/1034378361/gpt_image_playground'

function formatElapsed(value?: number | null) {
  if (value == null) return '-'
  const seconds = Math.max(0, Math.round(value / 1000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export default function Header() {
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setShowUserSettings = useStore((s) => s.setShowUserSettings)
  const currentView = useStore((s) => s.currentView)
  const setCurrentView = useStore((s) => s.setCurrentView)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)
  const backendUser = useStore((s) => s.backendUser)
  const channelLeaderboard = useStore((s) => s.channelLeaderboard)
  const queueStats = useStore((s) => s.queueStats)
  const tasks = useStore((s) => s.tasks ?? [])
  const { hasUpdate, latestRelease, dismiss } = useVersionCheck()
  const [showHelp, setShowHelp] = useState(false)
  const [showChannelStatus, setShowChannelStatus] = useState(false)
  const statusPanelRef = useRef<HTMLDivElement>(null)

  useCloseOnEscape(showChannelStatus, () => setShowChannelStatus(false))

  const healthSummary = useMemo(() => {
    const healthy = channelLeaderboard.filter((item) => item.healthStatus === 'healthy').length
    const problem = channelLeaderboard.filter((item) => item.healthStatus === 'degraded' || item.healthStatus === 'error').length
    return { healthy, problem, total: channelLeaderboard.length }
  }, [channelLeaderboard])

  const hasActiveLocalTask = useMemo(
    () => tasks.some((task) => task.status === 'queued' || task.status === 'running'),
    [tasks],
  )

  const shouldShowQueueStats = Boolean(
    queueStats && (hasActiveLocalTask || queueStats.queuedCount > 0 || queueStats.runningCount > 0),
  )

  useEffect(() => {
    if (!showChannelStatus) return
    const handlePointerDown = (event: MouseEvent) => {
      if (!statusPanelRef.current?.contains(event.target as Node)) {
        setShowChannelStatus(false)
      }
    }
    document.addEventListener('mousedown', handlePointerDown)
    return () => document.removeEventListener('mousedown', handlePointerDown)
  }, [showChannelStatus])

  return (
    <header className="safe-area-top sticky top-0 z-40 bg-white/80 dark:bg-gray-950/80 backdrop-blur border-b border-gray-200 dark:border-white/[0.08]">
      <div className="safe-area-x safe-header-inner max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-start gap-1">
          <h1 className="text-base sm:text-lg font-bold tracking-tight">
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-800 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              GPT Image
              <span className="hidden sm:inline"> Playground</span>
            </a>
          </h1>
          {hasUpdate && latestRelease && (
            <a
              href={latestRelease.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={dismiss}
              className="px-1.5 py-0.5 mt-0.5 rounded border border-red-500/30 text-[10px] font-bold bg-red-500 text-white hover:bg-red-600 transition-colors animate-fade-in leading-none"
              title={`新版本 ${latestRelease.tag}`}
            >
              NEW
            </a>
          )}
        </div>
        <div className="flex items-center gap-0.5 sm:gap-1">
          <div ref={statusPanelRef} className="relative hidden sm:block">
            <button
              type="button"
              onClick={() => setShowChannelStatus((value) => !value)}
              className="inline-flex items-center gap-1 sm:gap-2 rounded-xl border border-gray-200 bg-white/70 px-1.5 sm:px-2.5 py-1.5 text-xs text-gray-600 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-gray-900/70 dark:text-gray-300 dark:hover:bg-white/[0.06]"
              title="查看渠道状态"
            >
              <span className="font-medium hidden sm:inline">渠道状态</span>
              {healthSummary.total > 0 && (
                <>
                  <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300">
                    健康 {healthSummary.healthy}
                  </span>
                  {healthSummary.problem > 0 && (
                    <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] text-amber-600 dark:bg-amber-500/10 dark:text-amber-300">
                      异常 {healthSummary.problem}
                    </span>
                  )}
                </>
              )}
              <svg
                className={`h-3.5 w-3.5 text-gray-400 transition-transform ${showChannelStatus ? 'rotate-180' : ''}`}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {showChannelStatus && (
              <div className="absolute right-0 top-full z-50 mt-2 w-[min(92vw,36rem)] overflow-hidden rounded-2xl border border-gray-200/70 bg-white/95 p-3 shadow-[0_12px_40px_rgb(0,0,0,0.12)] ring-1 ring-black/5 backdrop-blur-xl dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-100">渠道状态</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">点击按钮展开，按成功生成排序</p>
                  </div>
                  {queueStats && (
                    <span className="text-xs text-gray-400 dark:text-gray-500">worker {queueStats.workerCount}</span>
                  )}
                </div>

                {shouldShowQueueStats && queueStats && (
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <StatusMetric label="全站排队" value={queueStats.queuedCount} tone="amber" />
                    <StatusMetric label="全站执行中" value={queueStats.runningCount} tone="blue" />
                    <StatusMetric label="我的排队" value={queueStats.yourQueuedCount} tone="amber" />
                    <StatusMetric label="我的执行中" value={queueStats.yourRunningCount} tone="blue" />
                  </div>
                )}

                {channelLeaderboard.length > 0 ? (
                  <div className="mt-3 max-h-[24rem] space-y-2 overflow-y-auto pr-1">
                    {channelLeaderboard.slice(0, 10).map((item) => (
                      <div
                        key={`${item.channelId}-${item.model}-${item.apiMode}`}
                        className="rounded-xl border border-gray-200/70 bg-gray-50/80 px-3 py-2.5 dark:border-white/[0.08] dark:bg-white/[0.03]"
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium text-gray-700 dark:text-gray-100">{item.channelName}</p>
                            <p className="mt-0.5 truncate text-xs text-gray-500 dark:text-gray-400">{item.model || '-'}</p>
                          </div>
                          <div className="flex flex-wrap items-center justify-end gap-1">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] ${healthBadgeClass(item.healthStatus)}`}>
                              {healthStatusLabel(item.healthStatus)}
                            </span>
                            <span className={`rounded-full px-2 py-0.5 text-[10px] ${compatibilityBadgeClass(item.compatibilityStatus)}`}>
                              {compatibilityStatusLabel(item.compatibilityStatus)}
                            </span>
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-4 gap-1.5 text-center text-[11px] text-gray-500 dark:text-gray-400">
                          <span className="rounded-lg bg-white px-1.5 py-1 dark:bg-white/[0.05]">成功 {item.successCount}</span>
                          <span className="rounded-lg bg-white px-1.5 py-1 dark:bg-white/[0.05]">{Math.round(item.successRate * 100)}%</span>
                          <span className="rounded-lg bg-white px-1.5 py-1 dark:bg-white/[0.05]">{formatElapsed(item.averageElapsed)}</span>
                          <span className="rounded-lg bg-white px-1.5 py-1 dark:bg-white/[0.05]">总计 {item.totalCount}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-3 rounded-xl border border-dashed border-gray-200/70 px-3 py-4 text-xs text-gray-400 dark:border-white/[0.08] dark:text-gray-500">
                    暂无渠道统计数据
                  </div>
                )}
              </div>
            )}
          </div>
          {backendUser && (
            <button
              type="button"
              onClick={() => setShowUserSettings(true)}
              className="mr-1 hidden items-center gap-2 rounded-xl border border-gray-200 bg-white/70 px-2 py-1 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-gray-900/70 dark:hover:bg-white/[0.06] sm:flex"
              title="个人设置"
            >
              <div className="min-w-0 text-left">
                <p className="truncate text-xs font-medium text-gray-700 dark:text-gray-200">{backendUser.username}</p>
                <p className="text-[10px] text-gray-400 dark:text-gray-500">{roleLabel(backendUser.role)}</p>
              </div>
              <svg className="h-3.5 w-3.5 shrink-0 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
          )}
          {backendUser && (
            <button
              type="button"
              onClick={() => setShowUserSettings(true)}
              className="rounded-lg p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200 sm:hidden"
              title="个人设置"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
            </button>
          )}
          <div className="flex items-center rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white/70 dark:bg-gray-900/70 p-0.5">
            <button
              onClick={() => setCurrentView('tasks')}
              className={`px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm transition ${
                currentView === 'tasks'
                  ? 'bg-brand-500 text-white shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]'
              }`}
            >
              任务
            </button>
            <button
              onClick={() => setCurrentView('templates')}
              className={`px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm transition ${
                currentView === 'templates'
                  ? 'bg-brand-500 text-white shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]'
              }`}
            >
              模板
            </button>
          </div>
          <button
            onClick={() => {
              setCurrentView('templates')
              setTemplateEditor({ mode: 'create' })
            }}
            className="p-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            title="新建模板"
          >
            <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
            </svg>
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="p-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            title="操作指南"
          >
            <svg
              className="w-5 h-5 text-gray-600 dark:text-gray-400"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              viewBox="0 0 24 24"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <path d="M12 17h.01" />
            </svg>
          </button>
          {canOpenSettings(backendUser) && (
            <button
              onClick={() => setShowSettings(true)}
              className="p-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
              title="管理控制台"
            >
              <svg
                className="w-5 h-5 text-gray-600 dark:text-gray-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
      {showHelp && (
        <Suspense fallback={null}>
          <HelpModal onClose={() => setShowHelp(false)} />
        </Suspense>
      )}
    </header>
  )
}

function StatusMetric({
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
    <div className={`rounded-xl px-3 py-2 text-sm ${className}`}>
      <div className="text-lg font-semibold">{value}</div>
      <div className="text-[11px] opacity-80">{label}</div>
    </div>
  )
}
