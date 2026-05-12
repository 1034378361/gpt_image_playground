import { useState } from 'react'
import { useStore } from '../store'
import { syncServerData } from '../storeBackend'
import { OPEN_PROMPT_LIBRARY_SOURCES, type OpenPromptLibrarySourceId } from '../lib/backendApi'
import { canManageSystem } from '../lib/roles'
import OpenPromptImportPreviewModal from './OpenPromptImportPreviewModal'

export default function AdminOpenPromptSources() {
  const openPromptSources = useStore((s) => s.openPromptSources)
  const backendUser = useStore((s) => s.backendUser)
  const [previewSource, setPreviewSource] = useState<OpenPromptLibrarySourceId | null>(null)

  const sources = OPEN_PROMPT_LIBRARY_SOURCES.map((source) => ({
    ...source,
    status: openPromptSources.find((item) => item.id === source.id),
  }))
  const isAdmin = canManageSystem(backendUser)

  return (
    <section className="pt-6 border-t border-gray-100 dark:border-white/[0.08]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">开源模板源</h4>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {isAdmin ? '导入默认进入审核队列。' : '你可以预览并导入开源模板，也可以处理公共模板审核。'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void syncServerData()}
          className="rounded-xl bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
        >
          刷新
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        {sources.map((source) => {
          const status = source.status
          return (
            <div
              key={source.id}
              className="rounded-xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{source.label}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-gray-500 dark:text-gray-400">{source.licenseNote}</p>
                </div>
                <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-200">
                  {status?.importedCount ?? 0}
                </span>
              </div>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center text-xs">
                <Metric label="新增" value={status?.lastCreated ?? 0} />
                <Metric label="更新" value={status?.lastUpdated ?? 0} />
                <Metric label="跳过" value={status?.lastSkipped ?? 0} />
              </div>

              <p className="mt-2 h-4 text-xs text-gray-400 dark:text-gray-500">
                {status?.lastSyncedAt ? `上次同步：${new Date(status.lastSyncedAt).toLocaleString('zh-CN')}` : '尚未同步'}
              </p>

              <div className="mt-3 flex gap-2">
                {status?.repoUrl && (
                  <a
                    href={status.repoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex-1 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center text-xs text-gray-600 transition hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                  >
                    仓库
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setPreviewSource(source.id)}
                  className="flex-1 rounded-lg bg-blue-500 px-3 py-2 text-xs font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  预览导入
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {previewSource && (
        <OpenPromptImportPreviewModal
          open={Boolean(previewSource)}
          source={previewSource}
          onClose={() => setPreviewSource(null)}
        />
      )}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-white px-2 py-1.5 dark:bg-white/[0.04]">
      <div className="font-medium text-gray-700 dark:text-gray-200">{value}</div>
      <div className="text-gray-400 dark:text-gray-500">{label}</div>
    </div>
  )
}
