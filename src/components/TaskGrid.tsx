import { useCallback, useMemo, useRef, useState, useEffect } from 'react'
import { useStore, reuseConfig, editOutputs, removeTask } from '../store'
import { cancelTask, loadMoreServerTasks, refreshQueueStats, retryTask } from '../storeBackend'
import TaskCard from './TaskCard'
import GenerationQueueStatus from './GenerationQueueStatus'
import { filterTasks } from '../lib/taskFilter'

export default function TaskGrid() {
  const tasks = useStore((s) => s.tasks)
  const searchQuery = useStore((s) => s.searchQuery)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const currentProjectId = useStore((s) => s.currentProjectId)
  const taskPage = useStore((s) => s.taskPage)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const hasOverlayOpen = useStore((s) =>
    Boolean(
      s.detailTaskId || s.lightboxImageId || s.maskEditorImageId || s.showSettings || s.showProjectManager || s.confirmDialog,
    ),
  )

  const rootRef = useRef<HTMLDivElement>(null)
  const gridRef = useRef<HTMLDivElement>(null)
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const isDragging = useRef(false)
  const dragStart = useRef<{ x: number; y: number } | null>(null)
  const hasDragged = useRef(false)
  const suppressClickUntil = useRef(0)
  const startedOnCard = useRef(false)
  const startedWithCtrl = useRef(false)
  const initialSelection = useRef<string[]>([])
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform)

  const filteredTasks = useMemo(
    () => filterTasks(tasks, { currentProjectId, filterStatus, filterFavorite, searchQuery }),
    [currentProjectId, tasks, searchQuery, filterStatus, filterFavorite],
  )
  const hasActiveTask = tasks.some((task) => task.status === 'queued' || task.status === 'running')

  const TASK_PAGE_SIZE = 30
  const [visibleTaskCount, setVisibleTaskCount] = useState(TASK_PAGE_SIZE)
  const taskSentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setVisibleTaskCount(TASK_PAGE_SIZE)
  }, [searchQuery, filterStatus, filterFavorite, currentProjectId])

  const canAutoLoadServerTasks = !searchQuery.trim() && filterStatus === 'all' && !filterFavorite && !currentProjectId
  const loadMoreTasks = useCallback(() => {
    if (visibleTaskCount < filteredTasks.length) {
      setVisibleTaskCount((prev) => Math.min(prev + TASK_PAGE_SIZE, filteredTasks.length))
      return
    }
    if (canAutoLoadServerTasks && taskPage.hasMore && !taskPage.loadingMore) {
      void loadMoreServerTasks()
    }
  }, [canAutoLoadServerTasks, filteredTasks.length, taskPage.hasMore, taskPage.loadingMore, visibleTaskCount])
  const canLoadMoreTasks = visibleTaskCount < filteredTasks.length || (canAutoLoadServerTasks && taskPage.hasMore)

  useEffect(() => {
    const sentinel = taskSentinelRef.current
    if (!sentinel) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMoreTasks()
      },
      { rootMargin: '200px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [loadMoreTasks])

  useEffect(() => {
    if (!hasActiveTask) return
    void refreshQueueStats()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshQueueStats()
      }
    }, 3000)
    return () => window.clearInterval(timer)
  }, [hasActiveTask])

  const handleDelete = (task: typeof tasks[0]) => {
    setConfirmDialog({
      title: '删除记录',
      message: '确定要删除这条记录吗？关联的图片资源也会被清理（如果没有其他任务引用）。',
      action: () => removeTask(task),
    })
  }

  const beginSelection = (target: HTMLElement, clientX: number, clientY: number, isCtrl: boolean) => {
    startedOnCard.current = Boolean(target.closest('.task-card-wrapper'))
    startedWithCtrl.current = isCtrl
    initialSelection.current = [...useStore.getState().selectedTaskIds]

    isDragging.current = true
    hasDragged.current = false
    dragStart.current = { x: clientX, y: clientY }
    document.body.classList.add('select-none')
    document.body.classList.add('drag-selecting')
    setSelectionBox({
      startX: clientX,
      startY: clientY,
      currentX: clientX,
      currentY: clientY,
    })
  }

  const updateSelectionFromPoint = (clientX: number, clientY: number) => {
    const start = dragStart.current
    if (!start || !gridRef.current) return

    const minX = Math.min(start.x, clientX)
    const maxX = Math.max(start.x, clientX)
    const minY = Math.min(start.y, clientY)
    const maxY = Math.max(start.y, clientY)

    const cards = gridRef.current.querySelectorAll('.task-card-wrapper')
    const newSelected = new Set(initialSelection.current)
    const initialSelected = new Set(initialSelection.current)

    cards.forEach((card) => {
      const rect = card.getBoundingClientRect()
      const taskId = card.getAttribute('data-task-id')
      if (!taskId) return

      const isIntersecting =
        minX < rect.right && maxX > rect.left && minY < rect.bottom && maxY > rect.top

      if (isIntersecting) {
        if (initialSelected.has(taskId)) {
          newSelected.delete(taskId)
        } else {
          newSelected.add(taskId)
        }
      } else if (!initialSelected.has(taskId)) {
        newSelected.delete(taskId)
      }
    })

    setSelectedTaskIds(Array.from(newSelected))
  }

  useEffect(() => {
    const handleDocumentMouseDown = (e: MouseEvent) => {
      if (hasOverlayOpen) return
      if (e.button !== 0) return
      const target = e.target as HTMLElement | null
      if (!target) return
      if (!target.closest('[data-home-main]')) return
      if (target.closest('[data-input-bar]')) return
      if (target.closest('[data-no-drag-select]')) return
      if (target.closest('button, a, input, textarea, select')) return

      const isCtrl = isMac ? e.metaKey : e.ctrlKey
      beginSelection(target, e.clientX, e.clientY, isCtrl)
    }

    const handleDocumentMouseMove = (e: MouseEvent) => {
      if (!isDragging.current || !dragStart.current) return

      const start = dragStart.current
      const distance = Math.hypot(e.clientX - start.x, e.clientY - start.y)
      if (distance < 6 && !hasDragged.current) return

      hasDragged.current = true
      setSelectionBox({
        startX: start.x,
        startY: start.y,
        currentX: e.clientX,
        currentY: e.clientY,
      })
      updateSelectionFromPoint(e.clientX, e.clientY)
      e.preventDefault()
    }

    const handleDocumentMouseUp = () => {
      if (isDragging.current) {
        document.body.classList.remove('select-none')
        document.body.classList.remove('drag-selecting')
      }
      if (isDragging.current && !hasDragged.current && !startedOnCard.current && !startedWithCtrl.current) {
        clearSelection()
      }
      if (isDragging.current && hasDragged.current) {
        suppressClickUntil.current = Date.now() + 250
      }
      isDragging.current = false
      dragStart.current = null
      setSelectionBox(null)
    }

    document.addEventListener('mousedown', handleDocumentMouseDown)
    document.addEventListener('mousemove', handleDocumentMouseMove)
    document.addEventListener('mouseup', handleDocumentMouseUp)
    return () => {
      document.removeEventListener('mousedown', handleDocumentMouseDown)
      document.removeEventListener('mousemove', handleDocumentMouseMove)
      document.removeEventListener('mouseup', handleDocumentMouseUp)
    }
  }, [clearSelection, hasOverlayOpen, isMac])

  if (!filteredTasks.length) {
    return (
      <>
        <GenerationQueueStatus />
        <div className="text-center py-20 text-gray-400 dark:text-gray-500">
          {searchQuery || filterFavorite ? (
            <p className="text-sm">没有找到匹配的记录</p>
          ) : (
            <>
              <svg
                className="w-16 h-16 mx-auto mb-4 text-gray-200 dark:text-gray-700"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1}
                  d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                />
              </svg>
              <p className="text-sm">输入提示词开始生成图片</p>
            </>
          )}
        </div>
      </>
    )
  }

  return (
    <div ref={rootRef} data-task-grid-root className="relative min-h-[50vh]">
      <GenerationQueueStatus />
      <div ref={gridRef} className="columns-2 sm:columns-2 lg:columns-3 gap-3 sm:gap-4 pb-10">
        {filteredTasks.slice(0, visibleTaskCount).map((task) => (
          <div key={task.id} className="task-card-wrapper break-inside-avoid mb-3 sm:mb-4" data-task-id={task.id}>
            <TaskCard
              task={task}
              onClick={(e) => {
                if (Date.now() < suppressClickUntil.current) {
                  e.preventDefault()
                  return
                }
                suppressClickUntil.current = 0
                const isCtrl = isMac ? e.metaKey : e.ctrlKey
                if (isCtrl) {
                  useStore.getState().toggleTaskSelection(task.id)
                } else if (selectedTaskIds.length > 0) {
                  clearSelection()
                  setDetailTaskId(task.id)
                } else {
                  setDetailTaskId(task.id)
                }
              }}
              onReuse={() => reuseConfig(task)}
              onEditOutputs={() => editOutputs(task)}
              onDelete={() => handleDelete(task)}
              onCancel={() => cancelTask(task)}
              onRetry={() => { void retryTask(task) }}
              isSelected={selectedTaskIds.includes(task.id)}
            />
          </div>
        ))}
      </div>
      {canLoadMoreTasks && <div ref={taskSentinelRef} className="h-10" />}
      {(taskPage.total > 0 || taskPage.loadingMore) && (
        <div className="pb-6 text-center text-xs text-gray-400 dark:text-gray-500">
          {taskPage.loadingMore ? '正在加载更多任务…' : `已加载 ${Math.min(taskPage.loaded, taskPage.total)} / 共 ${taskPage.total} 条任务`}
        </div>
      )}
      {selectionBox && (
        <div
          className="fixed bg-blue-500/20 border border-blue-500/50 pointer-events-none z-[100]"
          style={{
            left: Math.min(selectionBox.startX, selectionBox.currentX),
            top: Math.min(selectionBox.startY, selectionBox.currentY),
            width: Math.abs(selectionBox.currentX - selectionBox.startX),
            height: Math.abs(selectionBox.currentY - selectionBox.startY),
          }}
        />
      )}
    </div>
  )
}
