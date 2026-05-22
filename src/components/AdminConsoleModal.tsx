import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useStore } from '../store'
import { exportData, importData, loadBackendSession, previewSystemBackupFile } from '../storeBackend'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'
import AdminChannelManager from './AdminChannelManager'
import AdminOpenPromptSources from './AdminOpenPromptSources'
import AdminAuditLog from './AdminAuditLog'
import AdminUserManager from './AdminUserManager'
import AdminAuthManager from './AdminAuthManager'
import { canManageSystem, canOpenSettings, canReviewTemplates, roleLabel } from '../lib/roles'

declare const __APP_VERSION__: string

interface TabItem {
  id: string
  label: string
  adminOnly: boolean
}

const ALL_TABS: TabItem[] = [
  { id: 'users', label: '用户与访问', adminOnly: true },
  { id: 'channels', label: '渠道管理', adminOnly: true },
  { id: 'templates', label: '模板运营', adminOnly: false },
  { id: 'audit', label: '审计日志', adminOnly: true },
  { id: 'maintenance', label: '系统维护', adminOnly: true },
]

export default function AdminConsoleModal() {
  const showSettings = useStore((s) => s.showSettings)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const backendUser = useStore((s) => s.backendUser)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const importInputRef = useRef<HTMLInputElement>(null)

  const visible = showSettings && canOpenSettings(backendUser)

  useCloseOnEscape(visible, () => setShowSettings(false))

  const isAdmin = canManageSystem(backendUser)
  const canReview = canReviewTemplates(backendUser)

  const availableTabs = ALL_TABS.filter((tab) =>
    tab.adminOnly ? isAdmin : canReview,
  )

  const [activeTab, setActiveTab] = useState(availableTabs[0]?.id || 'users')

  if (!visible || !backendUser) return null

  const currentTab = availableTabs.find((t) => t.id === activeTab) ? activeTab : availableTabs[0]?.id

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
        confirmHint: '这是高风险操作。请输入"导入服务端备份"后继续。',
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
    <div className="fixed inset-0 z-[70] p-0 sm:p-4">
      <div
        className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in"
        onClick={() => setShowSettings(false)}
      />
      <div className="relative z-10 mx-auto flex h-full sm:h-[calc(100vh-32px)] w-full max-w-[1520px] flex-col overflow-hidden rounded-none sm:rounded-[28px] border-0 sm:border border-white/50 bg-white/95 shadow-2xl ring-0 sm:ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10">
        {/* Header */}
        <div className="sticky top-0 z-10 border-b border-gray-200/80 bg-white/90 px-5 py-4 backdrop-blur dark:border-white/[0.08] dark:bg-gray-900/90 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h3 className="text-lg font-semibold text-gray-800 dark:text-gray-100">管理控制台</h3>
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
        </div>

        {/* Body: tabs + content */}
        <div className="flex flex-col sm:flex-row flex-1 overflow-hidden">
          {/* Tab bar - mobile */}
          <div className="flex overflow-x-auto border-b border-gray-200/80 bg-gray-50/50 px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.02] sm:hidden">
            {availableTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-xs transition ${
                  currentTab === tab.id
                    ? 'bg-white font-medium text-gray-800 shadow-sm dark:bg-white/[0.08] dark:text-gray-100'
                    : 'text-gray-500 dark:text-gray-400'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Sidebar - desktop */}
          <nav className="hidden w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-gray-200/80 bg-gray-50/50 p-3 dark:border-white/[0.08] dark:bg-white/[0.02] sm:flex">
            {availableTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`rounded-xl px-3 py-2.5 text-left text-sm transition ${
                  currentTab === tab.id
                    ? 'bg-white font-medium text-gray-800 shadow-sm ring-1 ring-gray-200/70 dark:bg-white/[0.08] dark:text-gray-100 dark:ring-white/[0.08]'
                    : 'text-gray-600 hover:bg-white/80 hover:text-gray-800 dark:text-gray-400 dark:hover:bg-white/[0.04] dark:hover:text-gray-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          {/* Content panel */}
          <div className="flex-1 overflow-y-auto px-5 py-5 custom-scrollbar sm:px-6">
            {currentTab === 'users' && (
              <TabPanel>
                <AdminUserManager />
                <div className="mt-6">
                  <AdminAuthManager />
                </div>
              </TabPanel>
            )}
            {currentTab === 'channels' && (
              <TabPanel>
                <AdminChannelManager />
              </TabPanel>
            )}
            {currentTab === 'templates' && (
              <TabPanel>
                <AdminOpenPromptSources />
              </TabPanel>
            )}
            {currentTab === 'audit' && (
              <TabPanel>
                <AdminAuditLog />
              </TabPanel>
            )}
            {currentTab === 'maintenance' && (
              <TabPanel>
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
                  <p className="text-xs leading-relaxed text-gray-400 dark:text-gray-500">
                    备份导出和导入会直接作用于后端数据库。导入前系统会自动创建恢复点。
                  </p>
                </div>
              </TabPanel>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function TabPanel({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-gray-200/70 bg-gray-50/70 p-4 shadow-sm dark:border-white/[0.08] dark:bg-white/[0.03]">
      {children}
    </div>
  )
}