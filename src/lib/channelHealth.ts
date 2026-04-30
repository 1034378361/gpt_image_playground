import type { ChannelCompatibilityStatus, ChannelHealthStatus } from '../types'

export function healthStatusLabel(status: ChannelHealthStatus | undefined): string {
  switch (status) {
    case 'checking':
      return '检测中'
    case 'healthy':
      return '健康'
    case 'degraded':
      return '部分可用'
    case 'error':
      return '异常'
    default:
      return '未检测'
  }
}

export function healthBadgeClass(status: ChannelHealthStatus | undefined): string {
  switch (status) {
    case 'checking':
      return 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
    case 'healthy':
      return 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-300'
    case 'degraded':
      return 'bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-300'
    case 'error':
      return 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'
    default:
      return 'bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400'
  }
}

export function formatHealthTime(value?: number | null): string {
  if (!value) return '尚未检测'
  return new Date(value).toLocaleString('zh-CN')
}

export function compatibilityStatusLabel(status: ChannelCompatibilityStatus | undefined): string {
  switch (status) {
    case 'checking':
      return '兼容检测中'
    case 'standard':
      return '标准 OpenAI'
    case 'codex':
      return 'Codex CLI'
    case 'error':
      return '兼容异常'
    default:
      return '兼容未检测'
  }
}

export function compatibilityBadgeClass(status: ChannelCompatibilityStatus | undefined): string {
  switch (status) {
    case 'checking':
      return 'bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-300'
    case 'standard':
      return 'bg-sky-50 text-sky-600 dark:bg-sky-500/10 dark:text-sky-300'
    case 'codex':
      return 'bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-300'
    case 'error':
      return 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300'
    default:
      return 'bg-gray-100 text-gray-500 dark:bg-white/[0.06] dark:text-gray-400'
  }
}
