import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { syncServerData } from '../storeBackend'
import { roleLabel } from '../lib/roles'
import Select from './Select'

const ACTION_LABELS: Record<string, string> = {
  'channel.create': '创建渠道',
  'channel.update': '更新渠道',
  'channel.delete': '删除渠道',
  'channel.health_check': '检测渠道',
  'channel.compatibility_check': '识别接口',
  'system.export': '导出备份',
  'system.import': '导入备份',
  'template.submit': '提交模板',
  'template.approve': '通过模板',
  'template.reject': '驳回模板',
  'template.import_evolink': '导入精选库',
  'template.import_open_library': '导入开源库',
  'template.auto_import': '自动导入开源库',
  'template.auto_import_settings': '更新自动导入',
  'user.role_update': '修改用户角色',
  'generation.cancel': '取消生成',
}

type AuditFilter = 'all' | 'user' | 'system' | 'channel' | 'template'

function formatDetails(details: Record<string, unknown>): string {
  const entries = Object.entries(details).filter(([, value]) => value !== '' && value != null)
  if (!entries.length) return ''
  return entries
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`)
    .join(' · ')
}

function renderRoleUpdate(details: Record<string, unknown>) {
  const username = typeof details.username === 'string' ? details.username : ''
  const previousRole = typeof details.previousRole === 'string' ? details.previousRole : ''
  const nextRole = typeof details.nextRole === 'string' ? details.nextRole : ''
  if (!username || !previousRole || !nextRole) return null

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span className="rounded-full bg-white px-2 py-0.5 text-gray-600 dark:bg-white/[0.06] dark:text-gray-300">
        {username}
      </span>
      <span className="rounded-full bg-gray-100 px-2 py-0.5 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
        {roleLabel(previousRole as any)}
      </span>
      <span className="text-gray-400 dark:text-gray-500">→</span>
      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
        {roleLabel(nextRole as any)}
      </span>
    </div>
  )
}

function omitRoleUpdateFields(details: Record<string, unknown>): Record<string, unknown> {
  const { username, previousRole, nextRole, ...rest } = details
  void username
  void previousRole
  void nextRole
  return rest
}

export default function AdminAuditLog() {
  const auditLogs = useStore((s) => s.auditLogs)
  const [filter, setFilter] = useState<AuditFilter>('all')
  const visibleLogs = useMemo(
    () =>
      auditLogs.filter((log) => {
        if (filter === 'all') return true
        if (filter === 'user') return log.action.startsWith('user.')
        if (filter === 'system') return log.action.startsWith('system.')
        if (filter === 'channel') return log.action.startsWith('channel.')
        if (filter === 'template') return log.action.startsWith('template.')
        return true
      }),
    [auditLogs, filter],
  )

  return (
    <section className="pt-6 border-t border-gray-100 dark:border-white/[0.08]">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">审计日志</h4>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">可按关键操作类型快速筛选</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-36">
            <Select
              value={filter}
              onChange={(value) => setFilter(value as AuditFilter)}
              options={[
                { label: '全部操作', value: 'all' },
                { label: '用户权限', value: 'user' },
                { label: '系统备份', value: 'system' },
                { label: '渠道配置', value: 'channel' },
                { label: '模板运营', value: 'template' },
              ]}
              className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
          </div>
          <button
            type="button"
            onClick={() => void syncServerData()}
            className="rounded-xl bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:bg-white/[0.06] dark:text-gray-300 dark:hover:bg-white/[0.1]"
          >
            刷新
          </button>
        </div>
      </div>
      <div className="max-h-72 overflow-y-auto rounded-xl border border-gray-200/70 bg-gray-50/70 dark:border-white/[0.08] dark:bg-white/[0.03]">
        {visibleLogs.length === 0 ? (
          <p className="px-3 py-4 text-sm text-gray-400 dark:text-gray-500">暂无审计记录</p>
        ) : (
          <div className="divide-y divide-gray-200/70 dark:divide-white/[0.08]">
            {visibleLogs.map((log) => (
              <div key={log.id} className="px-3 py-2.5">
                {(() => {
                  const isRoleUpdate = log.action === 'user.role_update'
                  const extraDetails = isRoleUpdate ? omitRoleUpdateFields(log.details) : log.details
                  const formattedDetails = formatDetails(extraDetails)
                  return (
                    <>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
                    {ACTION_LABELS[log.action] ?? log.action}
                  </p>
                  <span className="text-xs text-gray-400 dark:text-gray-500">
                    {new Date(log.createdAt).toLocaleString('zh-CN')}
                  </span>
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {log.actorUsername || '系统'} · {log.resourceType}
                  {log.resourceId ? ` · ${log.resourceId}` : ''}
                </p>
                {log.action === 'user.role_update' && renderRoleUpdate(log.details)}
                {formattedDetails && (
                  <p className="mt-1 break-all text-xs text-gray-400 dark:text-gray-500">
                    {formattedDetails}
                  </p>
                )}
                    </>
                  )
                })()}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}
