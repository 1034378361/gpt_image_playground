import { useMemo, useRef, useState } from 'react'
import type { ApiChannelDraft, ChannelModel, CodexCliMode } from '../types'
import { useStore } from '../store'
import { removeAdminChannel, saveAdminChannel, testAdminChannelCompatibility, testAdminChannelHealth } from '../storeBackend'
import {
  compatibilityBadgeClass,
  compatibilityStatusLabel,
  formatHealthTime,
  healthBadgeClass,
  healthStatusLabel,
} from '../lib/channelHealth'
import Select from './Select'

function createEmptyDraft(): ApiChannelDraft {
  return {
    name: '',
    baseUrl: '',
    apiKey: '',
    models: [{ id: 'gpt-image-2', label: 'GPT Image 2', apiMode: 'images', enabled: true }],
    timeoutSeconds: 300,
    codexCli: false,
    codexCliMode: 'auto',
    isEnabled: true,
  }
}

function codexModeLabel(mode: CodexCliMode): string {
  if (mode === 'codex') return '运行: Codex CLI'
  if (mode === 'standard') return '运行: 标准 OpenAI'
  return '运行: 自动'
}

export default function AdminChannelManager() {
  const adminChannels = useStore((s) => s.adminChannels)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ApiChannelDraft>(() => createEmptyDraft())
  const [busy, setBusy] = useState(false)
  const [checkingId, setCheckingId] = useState<string | null>(null)
  const [compatibilityCheckingId, setCompatibilityCheckingId] = useState<string | null>(null)
  const listTopRef = useRef<HTMLHeadingElement | null>(null)

  const sortedChannels = useMemo(
    () => [...adminChannels].sort((a, b) => b.updatedAt - a.updatedAt),
    [adminChannels],
  )

  const resetDraft = () => {
    setEditingId(null)
    setDraft(createEmptyDraft())
  }

  const handleEdit = (channelId: string) => {
    const channel = adminChannels.find((item) => item.id === channelId)
    if (!channel) return
    setEditingId(channel.id)
    setDraft({
      name: channel.name,
      baseUrl: channel.baseUrl,
      apiKey: '',
      models: channel.models,
      timeoutSeconds: channel.timeoutSeconds,
      codexCli: channel.codexCli,
      codexCliMode: channel.codexCliMode ?? 'auto',
      isEnabled: channel.isEnabled,
    })
  }

  const patchModel = (index: number, patch: Partial<ChannelModel>) => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, modelIndex) => (modelIndex === index ? { ...model, ...patch } : model)),
    }))
  }

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

  const handleHealthCheck = (channelId: string) => {
    setCheckingId(channelId)
    void run(async () => {
      try {
        await testAdminChannelHealth(channelId)
      } finally {
        setCheckingId(null)
      }
    })
  }

  const handleCompatibilityCheck = (channelId: string, channelName: string) => {
    setConfirmDialog({
      title: '检测接口兼容性',
      message: `将对 ${channelName} 发起一次最小生成请求，用于判断它是标准 OpenAI 兼容接口还是 Codex CLI 风格接口。这个操作可能产生一次上游调用费用。是否继续？`,
      confirmText: '开始检测',
      action: () => {
        setCompatibilityCheckingId(channelId)
        void run(async () => {
          try {
            await testAdminChannelCompatibility(channelId)
          } finally {
            setCompatibilityCheckingId(null)
          }
        })
      },
    })
  }

  const handleSave = () => {
    const normalizedModels = draft.models
      .map((model) => ({
        ...model,
        id: model.id.trim(),
        label: model.label.trim(),
      }))
      .filter((model) => model.id)

    if (!draft.name.trim()) {
      showToast('渠道名称不能为空', 'error')
      return
    }
    if (!draft.baseUrl.trim()) {
      showToast('Base URL 不能为空', 'error')
      return
    }
    if (!editingId && !draft.apiKey.trim()) {
      showToast('新建渠道时必须填写 API Key', 'error')
      return
    }
    if (!normalizedModels.length) {
      showToast('至少保留一个模型', 'error')
      return
    }
    if (!Number.isFinite(draft.timeoutSeconds) || draft.timeoutSeconds < 10 || draft.timeoutSeconds > 600) {
      showToast('超时时间必须在 10 到 600 秒之间', 'error')
      return
    }

    void run(async () => {
      const creating = !editingId
      await saveAdminChannel(editingId, {
        ...draft,
        name: draft.name.trim(),
        baseUrl: draft.baseUrl.trim(),
        apiKey: draft.apiKey.trim(),
        timeoutSeconds: Math.round(draft.timeoutSeconds),
        models: normalizedModels,
      })
      resetDraft()
      if (creating) {
        window.requestAnimationFrame(() => {
          listTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
      }
    })
  }

  return (
    <section className="pt-6 border-t border-gray-100 dark:border-white/[0.08]">
      <h4 ref={listTopRef} className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200">管理员渠道配置</h4>
      <div className="space-y-3">
        {sortedChannels.map((channel) => (
          <div key={channel.id} className="rounded-xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-100">{channel.name}</p>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${channel.isEnabled ? 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300' : 'bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400'}`}>
                    {channel.isEnabled ? '启用' : '停用'}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${healthBadgeClass(channel.healthStatus)}`}>
                    {healthStatusLabel(channel.healthStatus)}
                  </span>
                  <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
                    {codexModeLabel(channel.codexCliMode ?? 'auto')}
                  </span>
                  <span className={`rounded-full px-2 py-0.5 text-[10px] ${compatibilityBadgeClass(channel.compatibilityStatus)}`}>
                    {compatibilityStatusLabel(channel.compatibilityStatus)}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 break-all">{channel.baseUrl}</p>
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">Key: {channel.apiKeyPreview || '未显示'}</p>
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">超时: {channel.timeoutSeconds} 秒</p>
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  健康度: {channel.healthMessage || '尚未检测'}
                  {channel.healthLatencyMs != null ? ` · ${channel.healthLatencyMs} ms` : ''}
                  {channel.healthCheckedAt ? ` · ${formatHealthTime(channel.healthCheckedAt)}` : ''}
                </p>
                <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                  兼容性: {channel.compatibilityMessage || '尚未检测'}
                  {channel.compatibilityCheckedAt ? ` · ${formatHealthTime(channel.compatibilityCheckedAt)}` : ''}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {channel.models.map((model) => (
                    <span key={`${channel.id}-${model.id}`} className="rounded-full bg-white px-2 py-0.5 text-[10px] text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
                      {model.label || model.id} / {model.apiMode}
                    </span>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => handleHealthCheck(channel.id)}
                  disabled={busy && checkingId === channel.id}
                  className="rounded-lg bg-emerald-50 px-3 py-1.5 text-xs text-emerald-600 hover:bg-emerald-100 disabled:opacity-50 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20"
                >
                  {checkingId === channel.id ? '检测中' : '检测'}
                </button>
                <button
                  type="button"
                  onClick={() => handleCompatibilityCheck(channel.id, channel.name)}
                  disabled={busy && compatibilityCheckingId === channel.id}
                  className="rounded-lg bg-indigo-50 px-3 py-1.5 text-xs text-indigo-600 hover:bg-indigo-100 disabled:opacity-50 dark:bg-indigo-500/10 dark:text-indigo-300 dark:hover:bg-indigo-500/20"
                >
                  {compatibilityCheckingId === channel.id ? '识别中' : '识别接口'}
                </button>
                <button
                  type="button"
                  onClick={() => handleEdit(channel.id)}
                  className="rounded-lg bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
                >
                  编辑
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setConfirmDialog({
                      title: '删除渠道',
                      message: `确定删除 ${channel.name} 吗？`,
                      action: () => {
                        void run(() => removeAdminChannel(channel.id))
                      },
                    })
                  }
                  className="rounded-lg bg-red-50 px-3 py-1.5 text-xs text-red-600 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        ))}

        <div className="rounded-xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-medium text-gray-700 dark:text-gray-100">{editingId ? '编辑渠道' : '新建渠道'}</p>
            {editingId && (
              <button
                type="button"
                onClick={resetDraft}
                className="rounded-lg bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-100 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
              >
                取消编辑
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft((current) => ({ ...current, name: e.target.value }))}
              placeholder="渠道名称"
              className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
            <input
              value={draft.baseUrl}
              onChange={(e) => setDraft((current) => ({ ...current, baseUrl: e.target.value }))}
              placeholder="https://api.openai.com/v1"
              className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
            <input
              value={String(draft.timeoutSeconds)}
              onChange={(e) => setDraft((current) => ({ ...current, timeoutSeconds: Number(e.target.value) || 0 }))}
              type="number"
              min={10}
              max={600}
              placeholder="超时秒数"
              className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
            <input
              value={draft.apiKey}
              onChange={(e) => setDraft((current) => ({ ...current, apiKey: e.target.value }))}
              placeholder={editingId ? '留空表示不更换' : 'API Key'}
              className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200 sm:col-span-2"
            />
          </div>

          <div className="mt-3 space-y-2">
            {draft.models.map((model, index) => (
              <div key={`${index}-${model.id}`} className="grid grid-cols-1 gap-2 sm:grid-cols-[1.2fr,1.2fr,0.9fr,auto,auto]">
                <input
                  value={model.label}
                  onChange={(e) => patchModel(index, { label: e.target.value })}
                  placeholder="显示名"
                  className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                />
                <input
                  value={model.id}
                  onChange={(e) => patchModel(index, { id: e.target.value })}
                  placeholder="模型 ID"
                  className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                />
                <Select
                  value={model.apiMode}
                  onChange={(value) => patchModel(index, { apiMode: value as ChannelModel['apiMode'] })}
                  options={[
                    { label: 'images', value: 'images' },
                    { label: 'responses', value: 'responses' },
                  ]}
                  className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                />
                <label className="flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-xs text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
                  <input
                    type="checkbox"
                    checked={model.enabled}
                    onChange={(e) => patchModel(index, { enabled: e.target.checked })}
                  />
                  启用
                </label>
                <button
                  type="button"
                  onClick={() => setDraft((current) => ({ ...current, models: current.models.filter((_, modelIndex) => modelIndex !== index) }))}
                  className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-600 hover:bg-red-100 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                >
                  删除
                </button>
              </div>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setDraft((current) => ({
                ...current,
                models: [...current.models, { id: '', label: '', apiMode: 'images', enabled: true }],
              }))}
              className="rounded-xl bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
            >
              添加模型
            </button>
            <Select
              value={draft.codexCliMode}
              onChange={(value) => setDraft((current) => ({
                ...current,
                codexCliMode: value as CodexCliMode,
                codexCli: value === 'codex' ? true : value === 'standard' ? false : current.codexCli,
              }))}
              options={[
                { label: '自动检测', value: 'auto' },
                { label: '标准 OpenAI', value: 'standard' },
                { label: 'Codex CLI', value: 'codex' },
              ]}
              className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
            <label className="flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
              <input
                type="checkbox"
                checked={draft.isEnabled}
                onChange={(e) => setDraft((current) => ({ ...current, isEnabled: e.target.checked }))}
              />
              启用渠道
            </label>
            <button
              type="button"
              onClick={handleSave}
              disabled={busy}
              className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
            >
              {editingId ? '保存渠道' : '创建渠道'}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
