import { useMemo, useState } from 'react'
import { useStore } from '../store'
import { updateAdminUserRole } from '../storeBackend'
import { resetUserPassword } from '../lib/backendApi'
import type { AdminUser } from '../types'
import { roleLabel } from '../lib/roles'
import Select from './Select'

const ROLE_OPTIONS: Array<{ label: string; value: AdminUser['role'] }> = [
  { label: '普通用户', value: 'user' },
  { label: '审核员', value: 'reviewer' },
  { label: '管理员', value: 'admin' },
]

function roleSummary(role: AdminUser['role']): string {
  if (role === 'admin') return '可管理渠道、密钥、备份、用户角色和模板审核'
  if (role === 'reviewer') return '可审核公共模板并导入开源模板，但不能管理系统配置'
  return '只能使用管理员开放的渠道与模板功能'
}

export default function AdminUserManager() {
  const adminUsers = useStore((s) => s.adminUsers)
  const backendUser = useStore((s) => s.backendUser)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const [savingUserId, setSavingUserId] = useState<string | null>(null)
  const [roleFilter, setRoleFilter] = useState<'all' | AdminUser['role']>('all')
  const adminCount = adminUsers.filter((user) => user.role === 'admin').length
  const visibleUsers = useMemo(
    () => adminUsers.filter((user) => roleFilter === 'all' || user.role === roleFilter),
    [adminUsers, roleFilter],
  )

  const handleRoleChange = (user: AdminUser, role: AdminUser['role']) => {
    const isCurrentAdmin = backendUser?.id === user.id && user.role === 'admin'
    const isLastAdmin = user.role === 'admin' && adminCount <= 1 && role !== 'admin'
    if (isCurrentAdmin || isLastAdmin) return
    if (user.role === role) return
    const touchesAdmin = user.role === 'admin' || role === 'admin'
    setConfirmDialog({
      title: '修改用户角色',
      message: [
        `将 ${user.username} 从“${roleLabel(user.role)}”调整为“${roleLabel(role)}”。`,
        '',
        `当前角色：${roleSummary(user.role)}`,
        `目标角色：${roleSummary(role)}`,
        touchesAdmin ? '' : '',
        touchesAdmin ? '这次变更涉及管理员权限，请确认你没有误操作。' : '修改后会立即影响该用户可见的管理功能。',
      ]
        .filter(Boolean)
        .join('\n'),
      confirmText: '确认修改',
      confirmKeyword: touchesAdmin ? user.username : undefined,
      confirmHint: touchesAdmin ? `此操作涉及管理员权限。请输入用户名 “${user.username}” 以继续。` : undefined,
      tone: touchesAdmin ? 'warning' : undefined,
      action: () => {
        setSavingUserId(user.id)
        void updateAdminUserRole(user.id, role).finally(() => setSavingUserId(null))
      },
    })
  }

  return (
    <section className="pt-6 border-t border-gray-100 dark:border-white/[0.08]">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h4 className="text-sm font-medium text-gray-800 dark:text-gray-200">用户与角色</h4>
          <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
            管理员拥有完整系统权限，审核员只能管理公共模板与审核队列。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-400 dark:text-gray-500">筛选</span>
          <div className="w-32">
            <Select
              value={roleFilter}
              onChange={(value) => setRoleFilter(value as typeof roleFilter)}
              options={[
                { label: '全部角色', value: 'all' },
                { label: '管理员', value: 'admin' },
                { label: '审核员', value: 'reviewer' },
                { label: '普通用户', value: 'user' },
              ]}
              className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
            />
          </div>
        </div>
      </div>

      <div className="space-y-3">
        {visibleUsers.map((user) => (
          (() => {
            const isCurrentAdmin = backendUser?.id === user.id && user.role === 'admin'
            const isLastAdmin = user.role === 'admin' && adminCount <= 1
            const roleLocked = isCurrentAdmin || isLastAdmin

            return (
              <div
                key={user.id}
                className="flex flex-col gap-3 rounded-xl border border-gray-200/70 bg-gray-50/70 p-3 dark:border-white/[0.08] dark:bg-white/[0.03] sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium text-gray-700 dark:text-gray-100">{user.username}</p>
                    <span className="rounded-full bg-white px-2 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                      {roleLabel(user.role)}
                    </span>
                    {backendUser?.id === user.id && (
                      <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] text-blue-600 dark:bg-blue-500/10 dark:text-blue-300">
                        当前登录
                      </span>
                    )}
                    {roleLocked && (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-200">
                        角色已锁定
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                    创建于 {new Date(user.createdAt).toLocaleString('zh-CN')}
                  </p>
                  {isCurrentAdmin && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-200">
                      当前登录管理员不能把自己的角色改成其它角色。
                    </p>
                  )}
                  {!isCurrentAdmin && isLastAdmin && (
                    <p className="mt-1 text-xs text-amber-600 dark:text-amber-200">
                      系统至少需要保留一个管理员，因此最后一个管理员不能被降权。
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-2 sm:w-auto">
                  <div className="sm:w-40">
                    <Select
                      value={user.role}
                      onChange={(value) => handleRoleChange(user, value as AdminUser['role'])}
                      disabled={savingUserId === user.id || roleLocked}
                      options={ROLE_OPTIONS}
                      className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                    />
                  </div>
                  {!isCurrentAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDialog({
                          title: '重置密码',
                          message: `确定要重置用户 ${user.username} 的密码吗？将生成一个临时密码，用户需要用临时密码登录后自行修改。`,
                          action: async () => {
                            try {
                              const result = await resetUserPassword(useStore.getState().settings, user.id)
                              showToast(`${user.username} 的临时密码：${result.tempPassword}（请复制保存）`, 'success')
                            } catch (err) {
                              showToast(err instanceof Error ? err.message : String(err), 'error')
                            }
                          },
                        })
                      }}
                      className="rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-xs text-gray-600 hover:bg-gray-100 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300 dark:hover:bg-white/[0.08]"
                    >
                      重置密码
                    </button>
                  )}
                </div>
              </div>
            )
          })()
        ))}
        {visibleUsers.length === 0 && (
          <div className="rounded-xl border border-dashed border-gray-200/80 px-4 py-6 text-center text-sm text-gray-400 dark:border-white/[0.08] dark:text-gray-500">
            当前筛选下没有用户
          </div>
        )}
      </div>
    </section>
  )
}
