import { Suspense, lazy, useState } from 'react'
import { useStore } from '../store'
import { logoutBackend } from '../storeBackend'
import { useVersionCheck } from '../hooks/useVersionCheck'
import { canOpenSettings, roleLabel } from '../lib/roles'

const HelpModal = lazy(() => import('./HelpModal'))

export default function Header() {
  const setShowSettings = useStore((s) => s.setShowSettings)
  const currentView = useStore((s) => s.currentView)
  const setCurrentView = useStore((s) => s.setCurrentView)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)
  const backendUser = useStore((s) => s.backendUser)
  const { hasUpdate, latestRelease, dismiss } = useVersionCheck()
  const [showHelp, setShowHelp] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await logoutBackend()
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <header className="safe-area-top sticky top-0 z-40 bg-white/80 dark:bg-gray-950/80 backdrop-blur border-b border-gray-200 dark:border-white/[0.08]">
      <div className="safe-area-x safe-header-inner max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-start gap-1">
          <h1 className="text-lg font-bold tracking-tight">
            <a
              href="https://github.com/CookSleep/gpt_image_playground"
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-800 dark:text-gray-100 hover:text-gray-600 dark:hover:text-gray-300 transition-colors"
            >
              GPT Image Playground
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
        <div className="flex items-center gap-1">
          {backendUser && (
            <div className="mr-1 hidden items-center gap-2 rounded-xl border border-gray-200 bg-white/70 px-2 py-1 dark:border-white/[0.08] dark:bg-gray-900/70 sm:flex">
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-gray-700 dark:text-gray-200">{backendUser.username}</p>
                <p className="text-[10px] text-gray-400 dark:text-gray-500">{roleLabel(backendUser.role)}</p>
              </div>
              <button
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                className="rounded-lg px-2 py-1 text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
                title="退出登录"
              >
                {loggingOut ? '退出中...' : '退出'}
              </button>
            </div>
          )}
          {backendUser && (
            <button
              onClick={() => void handleLogout()}
              disabled={loggingOut}
              className="rounded-lg px-2 py-1.5 text-xs text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-white/[0.06] dark:hover:text-gray-200 sm:hidden"
              title="退出登录"
            >
              {loggingOut ? '...' : '退出'}
            </button>
          )}
          <div className="flex items-center rounded-xl border border-gray-200 dark:border-white/[0.08] bg-white/70 dark:bg-gray-900/70 p-0.5">
            <button
              onClick={() => setCurrentView('tasks')}
              className={`px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm transition ${
                currentView === 'tasks'
                  ? 'bg-blue-500 text-white shadow-sm'
                  : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-white/[0.06]'
              }`}
            >
              任务
            </button>
            <button
              onClick={() => setCurrentView('templates')}
              className={`px-2 sm:px-3 py-1.5 rounded-lg text-xs sm:text-sm transition ${
                currentView === 'templates'
                  ? 'bg-blue-500 text-white shadow-sm'
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
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
            title="新建模板"
          >
            <svg className="w-5 h-5 text-gray-600 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m7-7H5" />
            </svg>
          </button>
          <button
            onClick={() => setShowHelp(true)}
            className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
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
              className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-900 transition-colors"
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
