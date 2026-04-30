import type { BackendUser } from '../types'

export function isAdmin(user: BackendUser | null | undefined): boolean {
  return user?.role === 'admin'
}

export function canReviewTemplates(user: BackendUser | null | undefined): boolean {
  return user?.role === 'admin' || user?.role === 'reviewer'
}

export function canManageSystem(user: BackendUser | null | undefined): boolean {
  return user?.role === 'admin'
}

export function canOpenSettings(user: BackendUser | null | undefined): boolean {
  return canReviewTemplates(user)
}

export function roleLabel(role: BackendUser['role']): string {
  if (role === 'admin') return '管理员'
  if (role === 'reviewer') return '审核员'
  return '普通用户'
}
