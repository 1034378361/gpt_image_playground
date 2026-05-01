import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import * as backendApi from '../lib/backendApi'
import type { AuthSettings, InviteCode, RegistrationMode } from '../types'

const REGISTRATION_MODE_OPTIONS: Array<{ value: RegistrationMode; label: string; summary: string }> = [
  { value: 'disabled', label: '关闭注册', summary: '只有已有账号可以登录，新用户无法自行注册。' },
  { value: 'open', label: '开放注册', summary: '任何人都可以直接注册成为普通用户。' },
  { value: 'invite_only', label: '邀请码注册', summary: '新用户必须填写管理员发放的邀请码。' },
]

export default function AdminAuthManager() {
  const settings = useStore((s) => s.settings)
  const showToast = useStore((s) => s.showToast)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)

  const [authSettings, setAuthSettings] = useState<AuthSettings | null>(null)
  const [inviteCodes, setInviteCodes] = useState<InviteCode[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [editingInviteId, setEditingInviteId] = useState<string | null>(null)
  const [expandedInviteHistoryId, setExpandedInviteHistoryId] = useState<string | null>(null)
  const [inviteUseHistory, setInviteUseHistory] = useState<Record<string, InviteCode['recentUses']>>({})
  const [draft, setDraft] = useState({
    note: '',
    maxUses: '',
    expiresAt: '',
    batchCount: '10',
  })
  const [editDraft, setEditDraft] = useState({
    note: '',
    maxUses: '',
    expiresAt: '',
  })

  const load = async () => {
    setLoading(true)
    try {
      const [nextSettings, nextInviteCodes] = await Promise.all([
        backendApi.getAdminAuthSettings(settings),
        backendApi.listInviteCodes(settings),
      ])
      setAuthSettings(nextSettings)
      setInviteCodes(nextInviteCodes)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [settings])

  const activeMode = authSettings?.registrationMode ?? 'open'
  const inviteModeEnabled = activeMode === 'invite_only'
  const activeModeMeta = useMemo(
    () => REGISTRATION_MODE_OPTIONS.find((item) => item.value === activeMode) ?? REGISTRATION_MODE_OPTIONS[1],
    [activeMode],
  )

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  const handleModeChange = (mode: RegistrationMode) => {
    if (mode === activeMode) return
    const option = REGISTRATION_MODE_OPTIONS.find((item) => item.value === mode)
    setConfirmDialog({
      title: '切换注册模式',
      message: [`将注册模式切换为“${option?.label ?? mode}”。`, '', option?.summary ?? ''].filter(Boolean).join('\n'),
      confirmText: '确认切换',
      confirmKeyword: mode === 'disabled' ? '关闭注册' : undefined,
      confirmHint: mode === 'disabled' ? '请输入“关闭注册”以继续。' : undefined,
      tone: mode === 'disabled' ? 'warning' : undefined,
      action: () => {
        void run(`mode:${mode}`, async () => {
          const saved = await backendApi.patchAdminAuthSettings(settings, mode)
          setAuthSettings(saved)
          showToast('注册模式已更新', 'success')
        })
      },
    })
  }

  const handleCreateInviteCode = () => {
    const note = draft.note.trim()
    const maxUses = draft.maxUses.trim() ? Number(draft.maxUses) : null
    const expiresAt = draft.expiresAt ? new Date(draft.expiresAt).getTime() : null
    if (maxUses !== null && (!Number.isFinite(maxUses) || maxUses <= 0)) {
      showToast('最大次数必须大于 0', 'error')
      return
    }
    if (draft.expiresAt && Number.isNaN(expiresAt)) {
      showToast('过期时间格式无效', 'error')
      return
    }
    void run('create', async () => {
      const created = await backendApi.createInviteCode(settings, {
        note,
        maxUses: maxUses === null ? null : Math.round(maxUses),
        expiresAt,
      })
      setInviteCodes((current) => [created, ...current])
      setDraft((current) => ({ ...current, note: '', maxUses: '', expiresAt: '' }))
      showToast(`邀请码已创建：${created.code}`, 'success')
    })
  }

  const handleBatchCreateInviteCodes = () => {
    const note = draft.note.trim()
    const maxUses = draft.maxUses.trim() ? Number(draft.maxUses) : 1
    const expiresAt = draft.expiresAt ? new Date(draft.expiresAt).getTime() : null
    const count = Number(draft.batchCount)
    if (!Number.isFinite(count) || count < 1 || count > 200) {
      showToast('批量数量必须在 1 到 200 之间', 'error')
      return
    }
    if (maxUses !== null && (!Number.isFinite(maxUses) || maxUses <= 0)) {
      showToast('最大次数必须大于 0', 'error')
      return
    }
    if (draft.expiresAt && Number.isNaN(expiresAt)) {
      showToast('过期时间格式无效', 'error')
      return
    }
    void run('batch-create', async () => {
      const created = await backendApi.createInviteCodesBatch(settings, {
        count: Math.round(count),
        note,
        maxUses: maxUses === null ? null : Math.round(maxUses),
        expiresAt,
      })
      setInviteCodes((current) => [...created.reverse(), ...current])
      setDraft((current) => ({ ...current, note: '', maxUses: '', expiresAt: '' }))
      showToast(`已批量创建 ${created.length} 个邀请码`, 'success')
    })
  }

  const handleToggleInvite = (item: InviteCode) => {
    void run(`toggle:${item.id}`, async () => {
      const updated = await backendApi.patchInviteCode(settings, item.id, { isEnabled: !item.isEnabled })
      setInviteCodes((current) => current.map((invite) => (invite.id === item.id ? updated : invite)))
      showToast(updated.isEnabled ? '邀请码已启用' : '邀请码已停用', 'success')
    })
  }

  const handleDeleteInvite = (item: InviteCode) => {
    setConfirmDialog({
      title: '删除邀请码',
      message: `将删除邀请码 ${item.code}。\n\n删除后不能恢复，也不能再用于注册。`,
      confirmText: '确认删除',
      confirmKeyword: item.code,
      confirmHint: `请输入邀请码 “${item.code}” 以继续。`,
      tone: 'danger',
      action: () => {
        void run(`delete:${item.id}`, async () => {
          await backendApi.deleteInviteCode(settings, item.id)
          setInviteCodes((current) => current.filter((invite) => invite.id !== item.id))
          showToast('邀请码已删除', 'success')
        })
      },
    })
  }

  const startEditingInvite = (item: InviteCode) => {
    setEditingInviteId(item.id)
    setEditDraft({
      note: item.note || '',
      maxUses: item.maxUses == null ? '' : String(item.maxUses),
      expiresAt: item.expiresAt ? toDatetimeLocalValue(item.expiresAt) : '',
    })
  }

  const cancelEditingInvite = () => {
    setEditingInviteId(null)
    setEditDraft({
      note: '',
      maxUses: '',
      expiresAt: '',
    })
  }

  const handleSaveInviteEdit = (item: InviteCode) => {
    const note = editDraft.note.trim()
    const maxUses = editDraft.maxUses.trim() ? Number(editDraft.maxUses) : null
    const expiresAt = editDraft.expiresAt ? new Date(editDraft.expiresAt).getTime() : null
    if (maxUses !== null && (!Number.isFinite(maxUses) || maxUses <= 0)) {
      showToast('最大次数必须大于 0', 'error')
      return
    }
    if (editDraft.expiresAt && Number.isNaN(expiresAt)) {
      showToast('过期时间格式无效', 'error')
      return
    }
    void run(`save-edit:${item.id}`, async () => {
      const updated = await backendApi.patchInviteCode(settings, item.id, {
        note,
        maxUses: maxUses === null ? null : Math.round(maxUses),
        expiresAt,
      })
      setInviteCodes((current) => current.map((invite) => (invite.id === item.id ? updated : invite)))
      cancelEditingInvite()
      showToast('邀请码已更新', 'success')
    })
  }

  const handleToggleInviteHistory = (item: InviteCode) => {
    if (expandedInviteHistoryId === item.id) {
      setExpandedInviteHistoryId(null)
      return
    }
    void run(`history:${item.id}`, async () => {
      const uses = await backendApi.listInviteCodeUses(settings, item.id, 200)
      setInviteUseHistory((current) => ({ ...current, [item.id]: uses }))
      setExpandedInviteHistoryId(item.id)
    })
  }

  const copyInviteCode = async (item: InviteCode) => {
    try {
      await navigator.clipboard.writeText(item.code)
      showToast('邀请码已复制', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const copyInviteRegistrationLink = async (item: InviteCode) => {
    try {
      await navigator.clipboard.writeText(buildInviteRegistrationLink(item.code))
      showToast('注册链接已复制', 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const copyAllActiveInviteCodes = async () => {
    const activeCodes = inviteCodes.filter((item) => item.isEnabled).map((item) => item.code)
    if (activeCodes.length === 0) {
      showToast('当前没有可复制的启用邀请码', 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(activeCodes.join('\n'))
      showToast(`已复制 ${activeCodes.length} 个邀请码`, 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const copyAllActiveInviteLinks = async () => {
    const activeLinks = inviteCodes
      .filter((item) => item.isEnabled)
      .map((item) => buildInviteRegistrationLink(item.code))
    if (activeLinks.length === 0) {
      showToast('当前没有可复制的启用注册链接', 'error')
      return
    }
    try {
      await navigator.clipboard.writeText(activeLinks.join('\n'))
      showToast(`已复制 ${activeLinks.length} 条注册链接`, 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const exportInviteCodesCsv = () => {
    if (inviteCodes.length === 0) {
      showToast('当前没有可导出的邀请码', 'error')
      return
    }
    const rows = [
      ['code', 'note', 'isEnabled', 'usedCount', 'maxUses', 'remainingUses', 'recentUsers', 'expiresAt', 'createdAt'],
      ...inviteCodes.map((item) => [
        item.code,
        item.note || '',
        item.isEnabled ? 'true' : 'false',
        String(item.usedCount),
        item.maxUses == null ? '' : String(item.maxUses),
        item.remainingUses == null ? '' : String(item.remainingUses),
        item.recentUses.map((use) => use.username || '未知用户').join(' | '),
        item.expiresAt ? new Date(item.expiresAt).toISOString() : '',
        new Date(item.createdAt).toISOString(),
      ]),
    ]
    const csv = '\uFEFF' + rows.map((row) => row.map(escapeCsvCell).join(',')).join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `invite-codes-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    showToast('邀请码列表已导出', 'success')
  }

  return (
    <section className="pt-6 border-t border-gray-100 dark:border-white/[0.08]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">注册与邀请码</h4>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            控制新用户是否可注册，以及是否必须使用邀请码。
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="rounded-xl bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
        >
          刷新
        </button>
      </div>

      <div className="rounded-xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="grid gap-2 sm:grid-cols-3">
          {REGISTRATION_MODE_OPTIONS.map((option) => {
            const active = option.value === activeMode
            return (
              <button
                key={option.value}
                type="button"
                disabled={loading || busy !== null}
                onClick={() => handleModeChange(option.value)}
                className={`rounded-xl border px-4 py-3 text-left transition ${
                  active
                    ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-400/30 dark:bg-blue-500/10 dark:text-blue-200'
                    : 'border-gray-200 bg-white text-gray-700 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]'
                } disabled:cursor-wait disabled:opacity-60`}
              >
                <div className="text-sm font-medium">{option.label}</div>
                <div className="mt-1 text-xs opacity-80">{option.summary}</div>
              </button>
            )
          })}
        </div>

        <div className="mt-3 rounded-xl bg-white px-4 py-3 text-sm text-gray-600 dark:bg-white/[0.04] dark:text-gray-300">
          当前模式：<span className="font-medium">{activeModeMeta.label}</span>
          <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">
            {authSettings?.hasUsers ? '系统已有用户' : '当前还没有用户，首个注册仍会自动成为管理员'}
          </span>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label className="min-w-0 flex-1">
            <span className="mb-1 block text-xs text-gray-400 dark:text-gray-500">备注</span>
            <input
              value={draft.note}
              onChange={(e) => setDraft((current) => ({ ...current, note: e.target.value }))}
              placeholder="例如：五月内测用户"
              className="w-full rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
          </label>
          <label className="w-full lg:w-40">
            <span className="mb-1 block text-xs text-gray-400 dark:text-gray-500">最大次数</span>
            <input
              value={draft.maxUses}
              onChange={(e) => setDraft((current) => ({ ...current, maxUses: e.target.value }))}
              placeholder="留空不限"
              inputMode="numeric"
              className="w-full rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
          </label>
          <label className="w-full lg:w-56">
            <span className="mb-1 block text-xs text-gray-400 dark:text-gray-500">过期时间</span>
            <input
              value={draft.expiresAt}
              onChange={(e) => setDraft((current) => ({ ...current, expiresAt: e.target.value }))}
              type="datetime-local"
              className="w-full rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
          </label>
          <label className="w-full lg:w-28">
            <span className="mb-1 block text-xs text-gray-400 dark:text-gray-500">批量数量</span>
            <input
              value={draft.batchCount}
              onChange={(e) => setDraft((current) => ({ ...current, batchCount: e.target.value }))}
              placeholder="10"
              inputMode="numeric"
              className="w-full rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
          </label>
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleCreateInviteCode}
            className="rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
          >
            创建邀请码
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={handleBatchCreateInviteCodes}
            className="rounded-xl bg-indigo-500 px-4 py-2.5 text-sm font-medium text-white hover:bg-indigo-600 disabled:opacity-50"
          >
            批量创建
          </button>
        </div>

        <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">
          批量创建时，如果“最大次数”留空，则默认按单次邀请码生成。
        </p>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void copyAllActiveInviteCodes()}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            复制全部启用邀请码
          </button>
          <button
            type="button"
            onClick={() => void copyAllActiveInviteLinks()}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            复制全部启用注册链接
          </button>
          <button
            type="button"
            onClick={exportInviteCodesCsv}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
          >
            导出 CSV
          </button>
        </div>

        <div className="mt-4 space-y-3">
          {inviteCodes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-gray-200/80 px-4 py-6 text-center text-sm text-gray-400 dark:border-white/[0.08] dark:text-gray-500">
              还没有邀请码。切到邀请码注册模式前，建议先创建至少一个邀请码。
            </div>
          ) : (
            inviteCodes.map((item) => (
              <div
                key={item.id}
                className="flex flex-col gap-3 rounded-xl border border-gray-200/70 bg-white p-3 dark:border-white/[0.08] dark:bg-white/[0.04] lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-mono text-sm font-medium text-gray-800 dark:text-gray-100">{item.code}</p>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] ${
                        item.isEnabled
                          ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-200'
                          : 'bg-gray-100 text-gray-500 dark:bg-white/[0.08] dark:text-gray-400'
                      }`}
                    >
                      {item.isEnabled ? '启用中' : '已停用'}
                    </span>
                    {item.remainingUses !== null && (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-400/15 dark:text-amber-200">
                        剩余 {item.remainingUses}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {item.note || '无备注'}
                    {' · '}
                    已使用 {item.usedCount}
                    {item.maxUses ? ` / ${item.maxUses}` : ' 次'}
                    {' · '}
                    {item.expiresAt ? `过期：${new Date(item.expiresAt).toLocaleString('zh-CN')}` : '永不过期'}
                  </p>
                  {item.recentUses.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {item.recentUses.map((use) => (
                        <span
                          key={use.id}
                          className="rounded-full bg-slate-100 px-2 py-1 text-[11px] text-slate-600 dark:bg-white/[0.08] dark:text-slate-300"
                        >
                          {use.username || '未知用户'} · {new Date(use.usedAt).toLocaleString('zh-CN')}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.usedCount > 0 && (
                    <div className="mt-2">
                      <button
                        type="button"
                        onClick={() => handleToggleInviteHistory(item)}
                        disabled={busy === `history:${item.id}`}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-[11px] text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                      >
                        {expandedInviteHistoryId === item.id ? '收起完整记录' : `查看完整记录 (${item.usedCount})`}
                      </button>
                    </div>
                  )}
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void copyInviteCode(item)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                  >
                    复制
                  </button>
                  <button
                    type="button"
                    onClick={() => void copyInviteRegistrationLink(item)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                  >
                    复制链接
                  </button>
                  <button
                    type="button"
                    onClick={() => startEditingInvite(item)}
                    disabled={busy !== null && busy !== `save-edit:${item.id}`}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleInvite(item)}
                    disabled={busy === `toggle:${item.id}`}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                  >
                    {item.isEnabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDeleteInvite(item)}
                    disabled={busy === `delete:${item.id}`}
                    className="rounded-lg bg-red-500 px-3 py-2 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    删除
                  </button>
                </div>

                {editingInviteId === item.id && (
                  <div className="w-full rounded-xl border border-blue-200/80 bg-blue-50/70 p-3 dark:border-blue-400/20 dark:bg-blue-500/10 lg:basis-full">
                    <div className="grid gap-3 lg:grid-cols-[1fr_160px_220px_auto]">
                      <label className="min-w-0">
                        <span className="mb-1 block text-xs text-blue-700 dark:text-blue-200">备注</span>
                        <input
                          value={editDraft.note}
                          onChange={(e) => setEditDraft((current) => ({ ...current, note: e.target.value }))}
                          className="w-full rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none dark:border-blue-400/20 dark:bg-white/[0.04] dark:text-gray-100"
                        />
                      </label>
                      <label>
                        <span className="mb-1 block text-xs text-blue-700 dark:text-blue-200">最大次数</span>
                        <input
                          value={editDraft.maxUses}
                          onChange={(e) => setEditDraft((current) => ({ ...current, maxUses: e.target.value }))}
                          placeholder="留空不限"
                          inputMode="numeric"
                          className="w-full rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none dark:border-blue-400/20 dark:bg-white/[0.04] dark:text-gray-100"
                        />
                      </label>
                      <label>
                        <span className="mb-1 block text-xs text-blue-700 dark:text-blue-200">过期时间</span>
                        <input
                          value={editDraft.expiresAt}
                          onChange={(e) => setEditDraft((current) => ({ ...current, expiresAt: e.target.value }))}
                          type="datetime-local"
                          className="w-full rounded-xl border border-blue-200 bg-white px-3 py-2 text-sm outline-none dark:border-blue-400/20 dark:bg-white/[0.04] dark:text-gray-100"
                        />
                      </label>
                      <div className="flex items-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleSaveInviteEdit(item)}
                          disabled={busy === `save-edit:${item.id}`}
                          className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50"
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          onClick={cancelEditingInvite}
                          disabled={busy === `save-edit:${item.id}`}
                          className="rounded-xl border border-blue-200 bg-white px-4 py-2 text-sm text-blue-700 hover:bg-blue-100 disabled:opacity-50 dark:border-blue-400/20 dark:bg-white/[0.04] dark:text-blue-200 dark:hover:bg-white/[0.08]"
                        >
                          取消
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {expandedInviteHistoryId === item.id && (
                  <div className="w-full rounded-xl border border-gray-200/70 bg-slate-50/80 p-3 dark:border-white/[0.08] dark:bg-white/[0.03] lg:basis-full">
                    <div className="mb-2 text-xs font-medium text-slate-600 dark:text-slate-300">完整使用记录</div>
                    <div className="space-y-2">
                      {(inviteUseHistory[item.id] ?? item.recentUses).map((use) => (
                        <div
                          key={use.id}
                          className="flex flex-col gap-1 rounded-lg border border-slate-200/80 bg-white px-3 py-2 text-xs text-slate-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-slate-300 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <span className="font-medium text-slate-700 dark:text-slate-200">{use.username || '未知用户'}</span>
                          <span>{new Date(use.usedAt).toLocaleString('zh-CN')}</span>
                        </div>
                      ))}
                      {(inviteUseHistory[item.id] ?? item.recentUses).length === 0 && (
                        <div className="rounded-lg border border-dashed border-slate-200/80 px-3 py-4 text-center text-xs text-slate-400 dark:border-white/[0.08] dark:text-slate-500">
                          暂无使用记录
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {inviteModeEnabled && inviteCodes.length === 0 && (
          <p className="mt-3 text-xs text-amber-600 dark:text-amber-200">
            当前已经切到邀请码注册模式，但系统里还没有邀请码，新用户将无法完成注册。
          </p>
        )}
      </div>
    </section>
  )
}

function escapeCsvCell(value: string): string {
  const normalized = String(value ?? '')
  if (/["\r\n,]/.test(normalized)) {
    return `"${normalized.replace(/"/g, '""')}"`
  }
  return normalized
}

function toDatetimeLocalValue(timestamp: number): string {
  const date = new Date(timestamp)
  const offset = date.getTimezoneOffset()
  const local = new Date(date.getTime() - offset * 60_000)
  return local.toISOString().slice(0, 16)
}

function buildInviteRegistrationLink(code: string): string {
  const url = new URL(window.location.href)
  url.searchParams.set('invite', code)
  url.hash = ''
  return url.toString()
}
