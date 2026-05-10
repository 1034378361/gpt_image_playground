import { useState } from 'react'
import { clearAllData, useStore } from '../store'
import { logoutBackend } from '../storeBackend'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { roleLabel } from '../lib/roles'

const CLEAR_MODE_OPTIONS = [
  { value: 'prompt_only', label: '仅清除提示词', description: '保留参考图和遮罩' },
  { value: 'prompt_and_images', label: '清除提示词和图片', description: '同时清除参考图和遮罩' },
  { value: 'keep_all', label: '保留全部内容', description: '提交后不清除任何输入' },
] as const

export default function UserSettingsModal() {
  const showUserSettings = useStore((s) => s.showUserSettings)
  const setShowUserSettings = useStore((s) => s.setShowUserSettings)
  const backendUser = useStore((s) => s.backendUser)
  const composerClearMode = useStore((s) => s.composerClearMode)
  const setComposerClearMode = useStore((s) => s.setComposerClearMode)
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [loggingOut, setLoggingOut] = useState(false)

  useCloseOnEscape(showUserSettings, () => setShowUserSettings(false))

  if (!showUserSettings || !backendUser) return null

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await logoutBackend()
    } finally {
      setLoggingOut(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in"
        onClick={() => setShowUserSettings(false)}
      />
      <div className="relative z-10 w-full max-w-md overflow-hidden rounded-2xl border border-gray-200/70 bg-white/95 shadow-2xl ring-1 ring-black/5 backdrop-blur animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-200/80 px-5 py-4 dark:border-white/[0.08]">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">个人设置</h3>
          <button
            onClick={() => setShowUserSettings(false)}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-5 px-5 py-5">
          {/* Account */}
          <section className="rounded-xl border border-gray-200/70 bg-gray-50/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100">{backendUser.username}</p>
                <span className="mt-0.5 inline-block rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-200">
                  {roleLabel(backendUser.role)}
                </span>
              </div>
              <button
                onClick={() => void handleLogout()}
                disabled={loggingOut}
                className="rounded-xl border border-red-200/80 bg-red-50/50 px-3 py-2 text-sm text-red-500 transition hover:bg-red-100/80 disabled:opacity-50 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
              >
                {loggingOut ? '退出中...' : '退出登录'}
              </button>
            </div>
          </section>

          {/* Composer clear mode */}
          <section className="rounded-xl border border-gray-200/70 bg-gray-50/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <p className="mb-3 text-sm font-medium text-gray-800 dark:text-gray-100">提交后清除行为</p>
            <div className="space-y-2">
              {CLEAR_MODE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`flex cursor-pointer items-start gap-3 rounded-lg px-3 py-2.5 transition ${
                    composerClearMode === option.value
                      ? 'bg-blue-50/80 ring-1 ring-blue-200 dark:bg-blue-500/10 dark:ring-blue-500/30'
                      : 'hover:bg-gray-100/80 dark:hover:bg-white/[0.04]'
                  }`}
                >
                  <input
                    type="radio"
                    name="composerClearMode"
                    value={option.value}
                    checked={composerClearMode === option.value}
                    onChange={() => setComposerClearMode(option.value)}
                    className="mt-0.5 accent-blue-500"
                  />
                  <div>
                    <p className="text-sm text-gray-700 dark:text-gray-200">{option.label}</p>
                    <p className="text-xs text-gray-400 dark:text-gray-500">{option.description}</p>
                  </div>
                </label>
              ))}
            </div>
          </section>

          {/* Theme */}
          <section className="rounded-xl border border-gray-200/70 bg-gray-50/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <p className="mb-3 text-sm font-medium text-gray-800 dark:text-gray-100">外观</p>
            <div className="flex gap-2">
              {([
                { value: 'system', label: '跟随系统' },
                { value: 'light', label: '浅色' },
                { value: 'dark', label: '深色' },
              ] as const).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setTheme(option.value)}
                  className={`flex-1 rounded-lg px-3 py-2 text-sm transition ${
                    theme === option.value
                      ? 'bg-blue-500 text-white shadow-sm'
                      : 'bg-white text-gray-600 hover:bg-gray-100 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]'
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </section>

          {/* Local data */}
          <section className="rounded-xl border border-gray-200/70 bg-gray-50/70 p-4 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <p className="mb-3 text-sm font-medium text-gray-800 dark:text-gray-100">本地数据</p>
            <button
              onClick={() =>
                setConfirmDialog({
                  title: '清空本地缓存',
                  message: '这只会清空当前浏览器中的本地任务缓存、本地模板缓存、图片缓存和本地参数配置。\n\n不会删除后端数据库中的用户、项目、模板、任务和图片资源。刷新同步后，后端数据仍会重新加载。',
                  confirmText: '确认清空',
                  confirmKeyword: '清空本地缓存',
                  confirmHint: '这是高风险操作。请输入"清空本地缓存"后才可继续。',
                  tone: 'danger',
                  action: () => clearAllData(),
                })
              }
              className="w-full rounded-xl border border-red-200/80 bg-red-50/50 px-4 py-2.5 text-sm text-red-500 transition hover:bg-red-100/80 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
            >
              清空本地缓存
            </button>
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
              只影响当前浏览器，不会删除后端数据。
            </p>
          </section>
        </div>
      </div>
    </div>
  )
}