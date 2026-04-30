import { useStore } from '../store'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import { useEffect, useState } from 'react'

export default function ConfirmDialog() {
  const confirmDialog = useStore((s) => s.confirmDialog)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const [confirmValue, setConfirmValue] = useState('')

  const handleClose = () => {
    setConfirmDialog(null)
  }

  const handleCancel = () => {
    confirmDialog?.cancelAction?.()
    handleClose()
  }

  useCloseOnEscape(Boolean(confirmDialog), handleClose)

  useEffect(() => {
    setConfirmValue('')
  }, [confirmDialog?.title, confirmDialog?.message, confirmDialog?.confirmKeyword])

  if (!confirmDialog) return null
  const isDestructive = confirmDialog.title.includes('删除') || confirmDialog.title.includes('清空')
  const confirmTone = confirmDialog.tone ?? (isDestructive ? 'danger' : undefined)
  const confirmClassName =
    confirmTone === 'warning'
      ? 'bg-orange-500 hover:bg-orange-600'
      : confirmTone === 'danger'
      ? 'bg-red-500 hover:bg-red-600'
      : 'bg-blue-500 hover:bg-blue-600'
  const confirmText = confirmDialog.confirmText ?? (isDestructive ? '确认删除' : '确认')
  const keywordMatched = !confirmDialog.confirmKeyword || confirmValue.trim() === confirmDialog.confirmKeyword

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-[110] flex items-center justify-center p-4"
      onClick={handleClose}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl border border-white/50 dark:border-white/[0.08] rounded-3xl shadow-[0_8px_40px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_40px_rgb(0,0,0,0.4)] max-w-sm w-full p-6 z-10 ring-1 ring-black/5 dark:ring-white/10 animate-confirm-in"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-base font-bold text-gray-800 dark:text-gray-100 mb-2">
          {confirmDialog.title}
        </h3>
        <p className={`text-sm text-gray-500 dark:text-gray-400 mb-6 leading-relaxed whitespace-pre-line ${confirmDialog.messageAlign === 'center' ? 'text-center' : ''}`}>
          {confirmDialog.message}
        </p>
        {confirmDialog.confirmKeyword && (
          <div className="mb-6 space-y-2">
            <div className="rounded-xl border border-red-200/80 bg-red-50/70 px-3 py-2 text-xs leading-relaxed text-red-600 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
              {confirmDialog.confirmHint ?? `请输入 “${confirmDialog.confirmKeyword}” 以继续。`}
            </div>
            <input
              value={confirmValue}
              onChange={(event) => setConfirmValue(event.target.value)}
              placeholder={confirmDialog.confirmKeyword}
              className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-red-300 focus:ring-2 focus:ring-red-500/20 dark:border-white/[0.08] dark:bg-gray-950 dark:text-gray-200 dark:focus:border-red-400/40"
            />
          </div>
        )}
        <div className="flex gap-2">
          <button
            onClick={handleCancel}
            className="flex-1 py-2 rounded-lg border border-gray-200 dark:border-white/[0.08] text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-white/[0.06] transition"
          >
            取消
          </button>
          <button
            onClick={() => {
              confirmDialog.action()
              setConfirmDialog(null)
            }}
            disabled={!keywordMatched}
            className={`flex-1 py-2 rounded-lg text-white text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${confirmClassName}`}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}
