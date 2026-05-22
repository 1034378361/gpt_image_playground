import { useCallback } from 'react'
import { useStore } from '../store'
import { removeTemplate } from '../storeTemplateActions'

export function useTemplateActionHelpers() {
  const setConfirmDialog = useStore((state) => state.setConfirmDialog)
  const showToast = useStore((state) => state.showToast)

  const runTemplateAction = useCallback((action: () => Promise<unknown>) => {
    void action().catch((err) => {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    })
  }, [showToast])

  const confirmDeleteTemplate = useCallback((templateId: string, options?: { beforeConfirm?: () => void }) => {
    options?.beforeConfirm?.()
    setConfirmDialog({
      title: '删除模板',
      message: '确定要删除这个模板吗？历史生成记录不会被删除。',
      action: () => {
        void removeTemplate(templateId).catch((err) => {
          showToast(err instanceof Error ? err.message : String(err), 'error')
        })
      },
    })
  }, [setConfirmDialog, showToast])

  return {
    runTemplateAction,
    confirmDeleteTemplate,
  }
}
