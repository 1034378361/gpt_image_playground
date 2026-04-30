import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { removeProject, saveProject } from '../storeBackend'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

const DEFAULT_COLOR = '#3b82f6'

export default function ProjectManagerModal() {
  const open = useStore((s) => s.showProjectManager)
  const setShowProjectManager = useStore((s) => s.setShowProjectManager)
  const projects = useStore((s) => s.projects)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const showToast = useStore((s) => s.showToast)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [isArchived, setIsArchived] = useState(false)

  useCloseOnEscape(open, () => setShowProjectManager(false))

  const editingProject = useMemo(
    () => projects.find((project) => project.id === editingId) ?? null,
    [editingId, projects],
  )

  useEffect(() => {
    if (!open) return
    if (editingProject) {
      setName(editingProject.name)
      setDescription(editingProject.description)
      setColor(editingProject.color || DEFAULT_COLOR)
      setIsArchived(editingProject.isArchived)
      return
    }
    setName('')
    setDescription('')
    setColor(DEFAULT_COLOR)
    setIsArchived(false)
  }, [editingProject, open])

  if (!open) return null

  const resetForm = () => {
    setEditingId(null)
    setName('')
    setDescription('')
    setColor(DEFAULT_COLOR)
    setIsArchived(false)
  }

  const handleSave = async () => {
    if (!name.trim()) {
      showToast('项目名称不能为空', 'error')
      return
    }
    try {
      await saveProject(editingId, {
        name: name.trim(),
        description: description.trim(),
        color,
        isArchived,
      })
      resetForm()
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-[92] flex items-center justify-center p-4"
      onClick={() => setShowProjectManager(false)}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative z-10 max-h-[90vh] w-full max-w-3xl overflow-hidden rounded-3xl border border-white/50 bg-white/95 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4 dark:border-white/[0.08]">
          <div>
            <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">项目空间</h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">把任务、模板和实验按主题归档。</p>
          </div>
          <button
            type="button"
            onClick={() => setShowProjectManager(false)}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="grid gap-0 md:grid-cols-[1.1fr,0.9fr]">
          <div className="max-h-[70vh] overflow-y-auto border-b border-gray-100 p-5 md:border-b-0 md:border-r dark:border-white/[0.08]">
            <div className="space-y-3">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  onClick={() => setEditingId(project.id)}
                  className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                    editingId === project.id
                      ? 'border-blue-300 bg-blue-50/80 dark:border-blue-400/30 dark:bg-blue-500/10'
                      : 'border-gray-200 bg-white hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:hover:bg-white/[0.06]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: project.color }} />
                        <span className="truncate text-sm font-medium text-gray-700 dark:text-gray-100">{project.name}</span>
                        {project.isArchived && (
                          <span className="rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                            已归档
                          </span>
                        )}
                      </div>
                      {project.description && (
                        <p className="mt-1 line-clamp-2 text-xs leading-5 text-gray-500 dark:text-gray-400">{project.description}</p>
                      )}
                    </div>
                    <div className="text-right text-[11px] text-gray-400 dark:text-gray-500">
                      <div>{project.taskCount} 任务</div>
                      <div>{project.templateCount} 模板</div>
                    </div>
                  </div>
                </button>
              ))}
              {!projects.length && (
                <div className="rounded-2xl border border-dashed border-gray-200 px-4 py-8 text-center text-sm text-gray-400 dark:border-white/[0.08] dark:text-gray-500">
                  还没有项目，右侧新建一个就行。
                </div>
              )}
            </div>
          </div>

          <div className="max-h-[70vh] overflow-y-auto p-5">
            <div className="mb-4 flex items-center justify-between gap-3">
              <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-100">{editingId ? '编辑项目' : '新建项目'}</h4>
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300 dark:hover:bg-white/[0.06]"
                >
                  新建一个
                </button>
              )}
            </div>

            <div className="space-y-3">
              <label className="block">
                <span className="mb-1 block text-xs text-gray-400 dark:text-gray-500">名称</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="w-full rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  placeholder="例如：电商白底、角色设定、品牌实验"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-gray-400 dark:text-gray-500">描述</span>
                <textarea
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={3}
                  className="w-full resize-y rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  placeholder="记录这个项目主要做什么、当前阶段、想保留哪些素材风格。"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-gray-400 dark:text-gray-500">颜色</span>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    className="h-10 w-12 rounded-xl border border-gray-200/70 bg-white p-1 dark:border-white/[0.08] dark:bg-white/[0.04]"
                  />
                  <input
                    value={color}
                    onChange={(event) => setColor(event.target.value)}
                    className="flex-1 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm outline-none dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200"
                  />
                </div>
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-gray-200/70 bg-white px-3 py-2 text-sm text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-300">
                <input type="checkbox" checked={isArchived} onChange={(event) => setIsArchived(event.target.checked)} />
                归档项目
              </label>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void handleSave()}
                className="rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
              >
                {editingId ? '保存项目' : '创建项目'}
              </button>
              {editingId && (
                <button
                  type="button"
                  onClick={() =>
                    setConfirmDialog({
                      title: '删除项目',
                      message: '删除后，项目下的任务和模板不会被删，只会回到未归类。',
                      tone: 'danger',
                      action: () => {
                        void removeProject(editingId).catch((err) => {
                          showToast(err instanceof Error ? err.message : String(err), 'error')
                        })
                        resetForm()
                      },
                    })
                  }
                  className="rounded-xl border border-red-200 bg-red-50 px-4 py-2 text-sm text-red-600 transition hover:bg-red-100 dark:border-red-400/20 dark:bg-red-500/10 dark:text-red-300 dark:hover:bg-red-500/20"
                >
                  删除项目
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
