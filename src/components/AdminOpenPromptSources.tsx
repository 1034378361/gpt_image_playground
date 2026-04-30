import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { runAutoImportNow, saveAutoImportSettings, syncServerData } from '../storeBackend'
import { OPEN_PROMPT_LIBRARY_SOURCES, type OpenPromptLibrarySourceId } from '../lib/backendApi'
import type { AutoImportSettingsPatch } from '../types'
import { canManageSystem } from '../lib/roles'
import OpenPromptImportPreviewModal from './OpenPromptImportPreviewModal'

function linesToList(value: string): string[] {
  return value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatTime(value?: number | null): string {
  return value ? new Date(value).toLocaleString('zh-CN') : '未运行'
}

function statusLabel(value: string): string {
  if (value === 'done') return '完成'
  if (value === 'error') return '失败'
  if (value === 'running') return '运行中'
  if (value === 'imported') return '已导入'
  if (value === 'discovered') return '已发现'
  if (value === 'skipped') return '已跳过'
  return value || '未知'
}

export default function AdminOpenPromptSources() {
  const openPromptSources = useStore((s) => s.openPromptSources)
  const backendUser = useStore((s) => s.backendUser)
  const autoImportSettings = useStore((s) => s.autoImportSettings)
  const autoImportRuns = useStore((s) => s.autoImportRuns)
  const openPromptDiscoveries = useStore((s) => s.openPromptDiscoveries)
  const showToast = useStore((s) => s.showToast)
  const [previewSource, setPreviewSource] = useState<OpenPromptLibrarySourceId | null>(null)
  const [busy, setBusy] = useState(false)
  const [draft, setDraft] = useState({
    enabled: false,
    runHour: 3,
    includeKnownSources: true,
    autoApproveTrusted: false,
    maxRepositories: 12,
    maxTemplatesPerRun: 80,
    minHotScore: 20,
    githubToken: '',
    searchQueries: 'gpt image prompts\ngpt-image-2 prompts\ngpt4o image prompts\nimage generation prompts',
    trustedRepos: '',
  })

  useEffect(() => {
    if (!autoImportSettings) return
    setDraft((current) => ({
      ...current,
      enabled: autoImportSettings.enabled,
      runHour: autoImportSettings.runHour,
      includeKnownSources: autoImportSettings.includeKnownSources,
      autoApproveTrusted: autoImportSettings.autoApproveTrusted,
      maxRepositories: autoImportSettings.maxRepositories,
      maxTemplatesPerRun: autoImportSettings.maxTemplatesPerRun,
      minHotScore: autoImportSettings.minHotScore,
      githubToken: '',
      searchQueries: autoImportSettings.searchQueries.join('\n'),
      trustedRepos: autoImportSettings.trustedRepos.join('\n'),
    }))
  }, [autoImportSettings])

  const sources = OPEN_PROMPT_LIBRARY_SOURCES.map((source) => ({
    ...source,
    status: openPromptSources.find((item) => item.id === source.id),
  }))
  const isAdmin = canManageSystem(backendUser)

  const latestRun = autoImportRuns[0]
  const topDiscoveries = useMemo(() => openPromptDiscoveries.slice(0, 8), [openPromptDiscoveries])

  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  const handleSave = () => {
    const payload: AutoImportSettingsPatch = {
      enabled: draft.enabled,
      runHour: Math.max(0, Math.min(23, Math.round(draft.runHour || 0))),
      includeKnownSources: draft.includeKnownSources,
      autoApproveTrusted: draft.autoApproveTrusted,
      maxRepositories: Math.max(1, Math.min(50, Math.round(draft.maxRepositories || 1))),
      maxTemplatesPerRun: Math.max(1, Math.min(300, Math.round(draft.maxTemplatesPerRun || 1))),
      minHotScore: Math.max(0, Number(draft.minHotScore) || 0),
      searchQueries: linesToList(draft.searchQueries),
      trustedRepos: linesToList(draft.trustedRepos),
    }
    if (draft.githubToken.trim()) payload.githubToken = draft.githubToken.trim()
    void run(() => saveAutoImportSettings(payload))
  }

  const handleClearToken = () => {
    void run(() => saveAutoImportSettings({ githubToken: '' }))
  }

  return (
    <section className="pt-6 border-t border-gray-100 dark:border-white/[0.08]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">开源模板源</h4>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            {isAdmin ? '自动导入默认进入审核队列，可信仓库可配置为自动通过。' : '你可以预览并导入开源模板，也可以处理公共模板审核。'}
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

      {isAdmin && (
        <div className="mt-4 rounded-xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-gray-800 dark:text-gray-100">每日自动检索</p>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              下次：{formatTime(autoImportSettings?.nextRunAt)} · 上次：{formatTime(autoImportSettings?.lastRunAt)}
              {autoImportSettings?.githubTokenPreview ? ` · GitHub Token ${autoImportSettings.githubTokenPreview}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void run(() => runAutoImportNow())}
              disabled={busy}
              className="rounded-xl bg-indigo-500 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
            >
              立即检索并导入
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className="rounded-xl bg-blue-500 px-3 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
            >
              保存设置
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => setDraft((current) => ({ ...current, enabled: e.target.checked }))}
            />
            启用每日任务
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
            <input
              type="checkbox"
              checked={draft.includeKnownSources}
              onChange={(e) => setDraft((current) => ({ ...current, includeKnownSources: e.target.checked }))}
            />
            包含内置源
          </label>
          <label className="flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
            <input
              type="checkbox"
              checked={draft.autoApproveTrusted}
              onChange={(e) => setDraft((current) => ({ ...current, autoApproveTrusted: e.target.checked }))}
            />
            可信源自动通过
          </label>
          <button
            type="button"
            onClick={handleClearToken}
            disabled={busy || !autoImportSettings?.githubTokenPreview}
            className="rounded-xl bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
          >
            清除 GitHub Token
          </button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <NumberInput label="运行小时" value={draft.runHour} min={0} max={23} onChange={(runHour) => setDraft((current) => ({ ...current, runHour }))} />
          <NumberInput label="最多仓库" value={draft.maxRepositories} min={1} max={50} onChange={(maxRepositories) => setDraft((current) => ({ ...current, maxRepositories }))} />
          <NumberInput label="最多模板" value={draft.maxTemplatesPerRun} min={1} max={300} onChange={(maxTemplatesPerRun) => setDraft((current) => ({ ...current, maxTemplatesPerRun }))} />
          <NumberInput label="最低热度" value={draft.minHotScore} min={0} max={10000} onChange={(minHotScore) => setDraft((current) => ({ ...current, minHotScore }))} />
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <textarea
            value={draft.searchQueries}
            onChange={(e) => setDraft((current) => ({ ...current, searchQueries: e.target.value }))}
            rows={5}
            placeholder="每行一个 GitHub 搜索关键词"
            className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
          />
          <textarea
            value={draft.trustedRepos}
            onChange={(e) => setDraft((current) => ({ ...current, trustedRepos: e.target.value }))}
            rows={5}
            placeholder="每行一个可信仓库，如 owner/repo"
            className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
          />
          <input
            value={draft.githubToken}
            onChange={(e) => setDraft((current) => ({ ...current, githubToken: e.target.value }))}
            placeholder="GitHub Token（留空不修改）"
            className="h-10 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
          />
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <div className="rounded-xl bg-white p-3 dark:bg-white/[0.04]">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400">运行记录</p>
              {latestRun && (
                <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                  {statusLabel(latestRun.status)}
                </span>
              )}
            </div>
            <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
              {autoImportRuns.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">暂无运行记录</p>
              ) : (
                autoImportRuns.slice(0, 5).map((run) => (
                  <div key={run.id} className="rounded-lg border border-gray-100 px-2 py-2 text-xs dark:border-white/[0.08]">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-gray-600 dark:text-gray-300">
                      <span>{run.trigger === 'scheduled' ? '定时' : '手动'} · {statusLabel(run.status)}</span>
                      <span>{formatTime(run.startedAt)}</span>
                    </div>
                    <p className="mt-1 text-gray-400 dark:text-gray-500">
                      仓库 {run.selectedRepositories}/{run.discoveredRepositories} · 新增 {run.created} · 待审 {run.submitted} · 通过 {run.approved}
                    </p>
                    {run.message && <p className="mt-1 break-all text-gray-400 dark:text-gray-500">{run.message}</p>}
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl bg-white p-3 dark:bg-white/[0.04]">
            <p className="mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">发现结果</p>
            <div className="max-h-48 space-y-2 overflow-y-auto pr-1">
              {topDiscoveries.length === 0 ? (
                <p className="text-xs text-gray-400 dark:text-gray-500">暂无发现结果</p>
              ) : (
                topDiscoveries.map((item) => (
                  <a
                    key={item.id}
                    href={item.repoUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block rounded-lg border border-gray-100 px-2 py-2 text-xs transition hover:bg-gray-50 dark:border-white/[0.08] dark:hover:bg-white/[0.05]"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-gray-700 dark:text-gray-200">
                      <span className="truncate">{item.label}</span>
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-400/15 dark:text-amber-200">
                        {Math.round(item.hotScore)}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-1 text-gray-400 dark:text-gray-500">
                      ★ {item.stars} · fork {item.forks} · 模板 {item.promptCount} · {statusLabel(item.lastStatus)}
                    </p>
                  </a>
                ))
              )}
            </div>
          </div>
        </div>
        </div>
      )}

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

function NumberInput({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  onChange: (value: number) => void
}) {
  return (
    <label className="min-w-0">
      <span className="mb-1 block text-xs text-gray-400 dark:text-gray-500">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => onChange(Number(e.target.value) || 0)}
        className="w-full rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
      />
    </label>
  )
}
