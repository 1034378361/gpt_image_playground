import { useRef, type ChangeEvent } from 'react'
import { clearAllData, exportData, importData, useStore } from '../store'
import { loadBackendSession, previewSystemBackupFile } from '../storeBackend'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import AdminChannelManager from './AdminChannelManager'
import AdminOpenPromptSources from './AdminOpenPromptSources'
import AdminAuditLog from './AdminAuditLog'
import AdminUserManager from './AdminUserManager'
import { canManageSystem, canOpenSettings, canReviewTemplates, roleLabel } from '../lib/roles'

export default function SettingsModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const backendUser = useStore((s) => s.backendUser)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const importInputRef = useRef<HTMLInputElement>(null)

  const visible = showSettings && canOpenSettings(backendUser)

  useCloseOnEscape(visible, () => setShowSettings(false))

  if (!visible || !backendUser) return null

  const isAdmin = canManageSystem(backendUser)
  const canReview = canReviewTemplates(backendUser)

  const handleImport = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || !isAdmin) return
    try {
      const preview = await previewSystemBackupFile(file)
      const counts = preview.tableCounts
      const lines = [
        `将导入 ${file.name}`,
        '',
        `用户 ${counts.users ?? 0} · 项目 ${counts.projects ?? 0} · 模板 ${counts.prompt_templates ?? 0}`,
        `任务 ${counts.generation_tasks ?? 0} · 资源 ${counts.assets ?? 0} · 渠道 ${counts.api_channels ?? 0}`,
        `审计 ${counts.audit_logs ?? 0} · 总记录 ${preview.totalRecords} · 文件资源 ${preview.assetFileCount}`,
        '',
        '导入前系统会自动创建一个恢复点，便于回滚。',
      ]
      setConfirmDialog({
        title: '导入服务端备份',
        message: lines.join('\n'),
        confirmText: '确认导入',
        confirmKeyword: '导入服务端备份',
        confirmHint: '这是高风险操作。请输入“导入服务端备份”后继续。',
        tone: 'danger',
        action: () => {
          void importData(file)
        },
      })
    } catch (err) {
      useStore.getState().showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in"
        onClick={() => setShowSettings(false)}
      />
      <div
        className="relative z-10 w-full max-w-4xl rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 overflow-y-auto max-h-[85vh] custom-scrollbar"
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">管理控制台</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">当前登录：{backendUser.username}</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-200">
              {roleLabel(backendUser.role)}
            </span>
            <span className="text-xs text-gray-400 dark:text-gray-500 font-mono select-none">v{__APP_VERSION__}</span>
            <button
              onClick={() => setShowSettings(false)}
              className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-blue-200/70 bg-blue-50/80 p-3 text-sm text-blue-700 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-blue-200">
          {isAdmin
            ? '管理员可以在这里统一维护上游渠道、模型、API Key、Base URL、请求超时、用户角色和服务端备份。普通用户不会看到这个界面。'
            : '审核员可以在这里处理公共模板审核与开源模板导入，但无法查看渠道密钥、系统备份或用户角色配置。'}
        </div>

        {isAdmin && <AdminUserManager />}
        {isAdmin && <AdminChannelManager />}
        {canReview && <AdminOpenPromptSources />}
        {isAdmin && <AdminAuditLog />}

        {isAdmin && (
          <section className="pt-6 border-t border-gray-100 dark:border-white/[0.08]">
          <div className="mb-4 flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">管理操作</h4>
            <button
              type="button"
              onClick={() => void loadBackendSession()}
              className="rounded-xl bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
            >
              刷新后端数据
            </button>
          </div>
          <div className="space-y-3">
            <div className="flex gap-2">
              <button
                onClick={() => exportData()}
                className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
              >
                导出服务端备份
              </button>
              <button
                onClick={() => importInputRef.current?.click()}
                className="flex-1 rounded-xl bg-gray-100/80 px-4 py-2.5 text-sm text-gray-600 transition hover:bg-gray-200 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
              >
                导入服务端备份
              </button>
              <input
                ref={importInputRef}
                type="file"
                accept=".zip"
                className="hidden"
                onChange={handleImport}
              />
            </div>
            <button
              onClick={() =>
                setConfirmDialog({
                  title: '清空本地缓存',
                  message: '这只会清空当前浏览器中的本地任务缓存、本地模板缓存、图片缓存和本地参数配置。\n\n不会删除后端数据库中的用户、项目、模板、任务和图片资源。刷新同步后，后端数据仍会重新加载。',
                  confirmText: '确认清空',
                  confirmKeyword: '清空本地缓存',
                  confirmHint: '这是高风险操作。请输入“清空本地缓存”后才可继续。',
                  tone: 'danger',
                  action: () => clearAllData(),
                })
              }
              className="w-full rounded-xl border border-red-200/80 bg-red-50/50 px-4 py-2.5 text-sm text-red-500 transition hover:bg-red-100/80 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-400 dark:hover:bg-red-500/20"
            >
              清空本地缓存
            </button>
            <p className="text-xs leading-relaxed text-gray-400 dark:text-gray-500">
              备份导出和导入会直接作用于后端数据库；清空本地缓存只影响当前浏览器。
            </p>
          </div>
          </section>
        )}
      </div>
    </div>
  )
}
