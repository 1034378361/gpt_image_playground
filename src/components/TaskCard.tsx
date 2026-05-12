import { useEffect, useState, useRef } from 'react'
import type { TaskRecord } from '../types'
import { useStore, getCachedImage, ensureImageCached, updateTaskInStore } from '../store'
import { formatImageRatio } from '../lib/size'
import { ParamValue } from '../lib/paramDisplay'
import { getTaskFailureSummary, getTaskQueuePosition } from '../lib/taskDiagnostics'

interface Props {
  task: TaskRecord
  onReuse: () => void
  onEditOutputs: () => void
  onDelete: () => void
  onCancel: () => void
  onClick: (e: React.MouseEvent | React.TouchEvent) => void
  isSelected?: boolean
}

export default function TaskCard({
  task,
  onReuse,
  onEditOutputs,
  onDelete,
  onCancel,
  onClick,
  isSelected,
}: Props) {
  const [thumbSrc, setThumbSrc] = useState<string>('')
  const [coverRatio, setCoverRatio] = useState<string>('')
  const [coverSize, setCoverSize] = useState<string>('')
  const [now, setNow] = useState(Date.now())
  const [swipeOffset, setSwipeOffset] = useState(0)
  const [isSwiping, setIsSwiping] = useState(false)
  const [swipeStartedSelected, setSwipeStartedSelected] = useState(false)
  const [swipeActionActive, setSwipeActionActive] = useState(false)
  const toggleTaskSelection = useStore((s) => s.toggleTaskSelection)
  const allTasks = useStore((s) => s.tasks)
  const touchStartRef = useRef<{ x: number; y: number } | null>(null)
  const swipeResetTimerRef = useRef<number | null>(null)
  const suppressClickUntilRef = useRef(0)
  const horizontalSwipeRef = useRef(false)

  const handleTouchStart = (e: React.TouchEvent) => {
    if (swipeResetTimerRef.current != null) {
      window.clearTimeout(swipeResetTimerRef.current)
      swipeResetTimerRef.current = null
    }
    touchStartRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
    horizontalSwipeRef.current = false
    setSwipeStartedSelected(Boolean(isSelected))
    setSwipeActionActive(false)
    setIsSwiping(true)
  }

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return
    const deltaX = e.touches[0].clientX - touchStartRef.current.x
    const deltaY = e.touches[0].clientY - touchStartRef.current.y
    
    // 如果主要是水平滑动
    if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 10) {
      horizontalSwipeRef.current = true
      e.preventDefault()
      // 限制滑动距离，例如最大 60px
      const boundedOffset = Math.max(-60, Math.min(60, deltaX))
      setSwipeOffset(boundedOffset)
      setSwipeActionActive(Math.abs(deltaX) >= 40)
    }
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    setIsSwiping(false)
    setSwipeOffset(0)
    
    if (!touchStartRef.current) return
    const deltaX = e.changedTouches[0].clientX - touchStartRef.current.x
    touchStartRef.current = null
    const isSwipeAction = horizontalSwipeRef.current && Math.abs(deltaX) > 40
    horizontalSwipeRef.current = false
    setSwipeActionActive(isSwipeAction)
    swipeResetTimerRef.current = window.setTimeout(() => {
      setSwipeActionActive(false)
      swipeResetTimerRef.current = null
    }, 220)

    // 如果是水平滑动，且垂直偏移较小，认为是滑动选择
    if (isSwipeAction) {
      suppressClickUntilRef.current = Date.now() + 350
      e.preventDefault()
      e.stopPropagation()
      toggleTaskSelection(task.id)
    }
  }

  const handleTouchCancel = () => {
    touchStartRef.current = null
    horizontalSwipeRef.current = false
    setIsSwiping(false)
    setSwipeOffset(0)
    setSwipeActionActive(false)
  }

  useEffect(() => () => {
    if (swipeResetTimerRef.current != null) {
      window.clearTimeout(swipeResetTimerRef.current)
    }
  }, [])

  const isActiveTask = task.status === 'queued' || task.status === 'running'

  // 定时更新排队/运行中任务的计时
  useEffect(() => {
    if (!isActiveTask) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [isActiveTask])

  // 加载缩略图
  useEffect(() => {
    setCoverRatio('')
    setCoverSize('')

    if (task.outputImages?.[0]) {
      const cached = getCachedImage(task.outputImages[0])
      if (cached) {
        setThumbSrc(cached)
      } else {
        ensureImageCached(task.outputImages[0]).then((url) => {
          if (url) setThumbSrc(url)
        })
      }
    }
  }, [task.outputImages])

  useEffect(() => {
    if (!thumbSrc) return

    let cancelled = false
    const image = new Image()
    image.onload = () => {
      if (!cancelled && image.naturalWidth > 0 && image.naturalHeight > 0) {
        setCoverRatio(formatImageRatio(image.naturalWidth, image.naturalHeight))
        setCoverSize(`${image.naturalWidth}×${image.naturalHeight}`)
      }
    }
    image.src = thumbSrc
    if (image.complete && image.naturalWidth > 0 && image.naturalHeight > 0) {
      setCoverRatio(formatImageRatio(image.naturalWidth, image.naturalHeight))
      setCoverSize(`${image.naturalWidth}×${image.naturalHeight}`)
    }

    return () => {
      cancelled = true
    }
  }, [thumbSrc])

  const duration = (() => {
    let seconds: number
    if (isActiveTask) {
      seconds = Math.floor((now - task.createdAt) / 1000)
    } else if (task.elapsed != null) {
      seconds = Math.floor(task.elapsed / 1000)
    } else {
      return '00:00'
    }
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0')
    const ss = String(seconds % 60).padStart(2, '0')
    return `${mm}:${ss}`
  })()
  const aggregateActualParams = task.outputImages?.length
    ? { ...task.actualParams, n: task.outputImages.length }
    : task.actualParams
  const queuePosition = task.status === 'queued' ? getTaskQueuePosition(allTasks, task.id) : null
  const failureSummary = task.status === 'error' ? getTaskFailureSummary(task) : ''
  const isSwipeReady = Math.abs(swipeOffset) >= 40
  const showSwipeAction = isSwipeReady || swipeActionActive
  const swipeBgClass = showSwipeAction
    ? swipeStartedSelected
      ? 'bg-gray-500 dark:bg-gray-600'
      : 'bg-blue-500'
    : 'bg-gray-200 dark:bg-gray-700'

  return (
    <div className="relative rounded-xl">
      {/* 侧滑底图 */}
      <div
        className={`absolute inset-0 rounded-xl flex items-center transition-opacity duration-200 pointer-events-none ${
          isSwiping || swipeOffset || swipeActionActive ? 'opacity-100' : 'opacity-0'
        } ${swipeBgClass} ${
          swipeOffset > 0 ? 'justify-start pl-6' : 'justify-end pr-6'
        }`}
      >
        <svg className={`w-8 h-8 transition-transform duration-150 ${showSwipeAction ? 'scale-110 text-white' : 'scale-90 text-white/60'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {swipeStartedSelected && showSwipeAction ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          )}
        </svg>
      </div>

      <div
        className={`group relative bg-white dark:bg-gray-900 rounded-xl border overflow-hidden cursor-pointer duration-200 hover:shadow-lg dark:hover:bg-gray-800/80 ${
          !isSwiping ? 'transition-[box-shadow,border-color,background-color,transform]' : 'transition-[box-shadow,border-color,background-color]'
        } ${
          task.status === 'queued'
            ? 'border-amber-300'
            : task.status === 'running'
            ? 'border-blue-400 generating'
            : isSelected
            ? 'border-blue-500 shadow-md ring-2 ring-blue-500/50'
            : 'border-gray-200 dark:border-white/[0.08] hover:border-gray-300 dark:hover:border-white/[0.18]'
        }`}
        style={{
          transform: swipeOffset ? `translateX(${swipeOffset}px)` : undefined,
        }}
        onClick={(e) => {
          if (Date.now() < suppressClickUntilRef.current) {
            e.preventDefault()
            e.stopPropagation()
            return
          }
          onClick(e)
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchCancel}
      >
        {/* 选中时的角标 / hover 时的复选框 */}
      <label
        className={`absolute top-2 right-2 z-10 flex h-5 w-5 items-center justify-center rounded-full border transition ${isSelected ? 'border-blue-500 bg-blue-500' : 'border-gray-300 bg-white/90 backdrop-blur opacity-0 group-hover:opacity-100 dark:border-gray-600 dark:bg-gray-800/90'}`}
        onClick={(e) => { e.stopPropagation(); toggleTaskSelection(task.id) }}
      >
        {isSelected && (
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </label>
      <div className="flex flex-col">
        {/* 图片区域 */}
        <div className="w-full bg-gray-100 dark:bg-black/20 relative flex items-center justify-center overflow-hidden" style={{ minHeight: '6rem' }}>
          {task.status === 'queued' && (
            <div className="flex flex-col items-center gap-2">
              <svg className="w-8 h-8 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-xs text-gray-400 dark:text-gray-500">
                {queuePosition ? `排队中 #${queuePosition}` : '排队中...'}
              </span>
            </div>
          )}
          {task.status === 'running' && (
            <div className="flex flex-col items-center gap-2">
              <svg
                className="w-8 h-8 text-blue-400 animate-spin"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
              <span className="text-xs text-gray-400 dark:text-gray-500">生成中...</span>
            </div>
          )}
          {task.status === 'error' && (
            <div className="flex flex-col items-center gap-1 px-2">
              <svg
                className="w-7 h-7 text-red-400"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              </svg>
              <span className="text-xs text-red-400 text-center leading-tight">{failureSummary}</span>
            </div>
          )}
          {task.status === 'canceled' && (
            <div className="flex flex-col items-center gap-1 px-2">
              <svg className="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
              </svg>
              <span className="text-xs text-gray-400 text-center leading-tight">
                已取消
              </span>
            </div>
          )}
          {task.status === 'done' && thumbSrc && (
            <>
              <img
                src={thumbSrc}
                data-image-id={task.outputImages[0]}
                data-template-id={task.templateId}
                className="w-full object-contain"
                loading="lazy"
                alt=""
              />
              {task.outputImages.length > 1 && (
                <span className="absolute bottom-1 right-1 bg-black/60 text-white text-xs px-1.5 py-0.5 rounded">
                  {task.outputImages.length}
                </span>
              )}
            </>
          )}
          {task.status === 'done' && !thumbSrc && (
            <svg
              className="w-8 h-8 text-gray-300"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          )}
          {/* 运行中显示耗时，完成后显示封面图比例与分辨率标签 */}
          <div className="absolute top-1.5 left-1.5 flex items-center gap-1">
            {task.status !== 'done' || !coverRatio || !coverSize ? (
              <span className="flex items-center gap-1 bg-black/50 text-white text-[10px] sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm font-mono">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                {duration}
              </span>
            ) : (
              <>
                <span className="bg-black/50 text-white text-[10px] sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm font-mono">
                  {coverRatio}
                </span>
                <span className="bg-black/50 text-white/90 text-[10px] sm:text-xs px-1.5 py-0.5 rounded backdrop-blur-sm font-medium">
                  {coverSize}
                </span>
              </>
            )}
          </div>
        </div>
        <div className="p-3 flex flex-col min-w-0">
          {(task.variationLabel || task.projectId) && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {task.variationLabel && (
                <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] text-violet-600 dark:bg-violet-500/10 dark:text-violet-300">
                  {task.variationLabel}
                </span>
              )}
              {task.projectId && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-600 dark:bg-white/[0.06] dark:text-slate-300">
                  项目
                </span>
              )}
            </div>
          )}
          <div className="flex-1 min-h-0 mb-2">
            <p className="text-sm text-gray-700 dark:text-gray-300 leading-relaxed line-clamp-3">
              {task.prompt || '(无提示词)'}
            </p>
          </div>
          <div className="mt-auto flex flex-col gap-1.5">
            {/* 参数：横向滚动 */}
            <div className="flex overflow-x-auto hide-scrollbar gap-1.5 whitespace-nowrap mask-edge-r min-w-0 pr-2">
              <ParamValue task={task} paramKey="quality" className="text-xs px-1.5 py-0.5 rounded flex-shrink-0" />
              <ParamValue task={task} paramKey="size" className="text-xs px-1.5 py-0.5 rounded flex-shrink-0" />
              <ParamValue task={task} paramKey="output_format" className="text-xs px-1.5 py-0.5 rounded flex-shrink-0" />
              <ParamValue task={task} paramKey="n" className="text-xs px-1.5 py-0.5 rounded flex-shrink-0" actualParams={aggregateActualParams} />
              {task.maskImageId && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 flex-shrink-0">
                  mask
                </span>
              )}
              </div>
            {/* 操作按钮 */}
            <div
              className="flex gap-1 justify-end flex-shrink-0"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() =>
                  updateTaskInStore(task.id, { isFavorite: !task.isFavorite })
                }
                className={`p-2 rounded-md transition ${
                  task.isFavorite
                    ? 'text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'
                    : 'text-gray-400 hover:text-yellow-400 hover:bg-yellow-50 dark:hover:bg-yellow-500/10'
                }`}
                title={task.isFavorite ? '取消收藏' : '收藏记录'}
              >
                <svg
                  className="w-4 h-4"
                  fill={task.isFavorite ? 'currentColor' : 'none'}
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                  />
                </svg>
              </button>
              <button
                onClick={onReuse}
                className="p-2 rounded-md hover:bg-blue-50 dark:hover:bg-blue-950/30 text-gray-400 hover:text-blue-500 transition"
                title="复用配置"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
                  />
                </svg>
              </button>
              <button
                onClick={onEditOutputs}
                className="p-2 rounded-md hover:bg-green-50 dark:hover:bg-green-950/30 text-gray-400 hover:text-green-500 transition disabled:opacity-30"
                title="编辑输出"
                disabled={!task.outputImages?.length}
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                  />
                </svg>
              </button>
              {isActiveTask && (
                <button
                  onClick={onCancel}
                  className="p-2 rounded-md hover:bg-amber-50 dark:hover:bg-amber-950/30 text-gray-400 hover:text-amber-500 transition"
                  title="取消任务"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
              <button
                onClick={onDelete}
                className="p-2 rounded-md hover:bg-red-50 dark:hover:bg-red-950/30 text-gray-400 hover:text-red-500 transition"
                title="删除记录"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  )
}
