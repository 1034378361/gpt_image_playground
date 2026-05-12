import { useRef, useEffect, useCallback, useState, useMemo } from 'react'
import { useStore, addImageFromFile, updateTaskInStore, removeMultipleTasks, selectChannelModel, optimizeCurrentPrompt, ensureImageCached } from '../store'
import { refreshGenerationPreflight, submitTask } from '../storeBackend'
import { DEFAULT_PARAMS } from '../types'
import { createMaskPreviewDataUrl } from '../lib/canvasImage'
import { canManageSystem } from '../lib/roles'
import SizePickerModal from './SizePickerModal'
import ExperimentLabModal from './ExperimentLabModal'
import ComposerParams from './ComposerParams'
import ComposerImages from './ComposerImages'

/** 通用悬浮气泡提示 */
function ButtonTooltip({ visible, text }: { visible: boolean; text: string }) {
  if (!visible) return null
  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 pointer-events-none z-10 whitespace-nowrap">
      <div className="relative bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg">
        {text}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-800" />
      </div>
    </div>
  )
}

/** API 支持的最大参考图数量 */
const API_MAX_IMAGES = 16

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

export default function InputBar() {
  const prompt = useStore((s) => s.prompt)
  const setPrompt = useStore((s) => s.setPrompt)
  const inputImages = useStore((s) => s.inputImages)
  const removeInputImage = useStore((s) => s.removeInputImage)
  const clearInputImages = useStore((s) => s.clearInputImages)
  const params = useStore((s) => s.params)
  const setParams = useStore((s) => s.setParams)
  const settings = useStore((s) => s.settings)
  const backendUser = useStore((s) => s.backendUser)
  const channels = useStore((s) => s.channels)
  const projects = useStore((s) => s.projects)
  const currentProjectId = useStore((s) => s.currentProjectId)
  const pendingParentTaskId = useStore((s) => s.pendingParentTaskId)
  const generationPreflight = useStore((s) => s.generationPreflight)
  const composerRevealTick = useStore((s) => s.composerRevealTick)
  const setShowSettings = useStore((s) => s.setShowSettings)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setConfirmDialog = useStore((s) => s.setConfirmDialog)
  const selectedTaskIds = useStore((s) => s.selectedTaskIds)
  const setSelectedTaskIds = useStore((s) => s.setSelectedTaskIds)
  const clearSelection = useStore((s) => s.clearSelection)
  const tasks = useStore((s) => s.tasks)
  const filterStatus = useStore((s) => s.filterStatus)
  const filterFavorite = useStore((s) => s.filterFavorite)
  const searchQuery = useStore((s) => s.searchQuery)
  const templates = useStore((s) => s.templates)
  const activeTemplateId = useStore((s) => s.activeTemplateId)
  const setActiveTemplateId = useStore((s) => s.setActiveTemplateId)
  const setTemplateEditor = useStore((s) => s.setTemplateEditor)
  const setSelectedTemplateId = useStore((s) => s.setSelectedTemplateId)
  const setCurrentView = useStore((s) => s.setCurrentView)
  const showToast = useStore((s) => s.showToast)
  const activeTemplate = templates.find((template) => template.id === activeTemplateId) ?? null
  const currentProject = currentProjectId && currentProjectId !== '__unassigned__'
    ? projects.find((project) => project.id === currentProjectId) ?? null
    : null
  const pendingParentTask = pendingParentTaskId
    ? tasks.find((task) => task.id === pendingParentTaskId) ?? null
    : null
  const currentChannel = channels.find((channel) => channel.id === settings.channelId) ?? null
  const enabledModels = currentChannel?.models.filter((model) => model.enabled) ?? []

  const filteredTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt)
    const q = searchQuery.trim().toLowerCase()
    
    return sorted.filter((t) => {
      if (filterFavorite && !t.isFavorite) return false
      const matchStatus = filterStatus === 'all' || t.status === filterStatus
      if (!matchStatus) return false
      
      if (!q) return true
      const prompt = (t.prompt || '').toLowerCase()
      const paramStr = JSON.stringify(t.params).toLowerCase()
      return prompt.includes(q) || paramStr.includes(q)
    })
  }, [tasks, searchQuery, filterStatus, filterFavorite])

  const handleSelectAllToggle = useCallback(() => {
    if (selectedTaskIds.length === filteredTasks.length && filteredTasks.length > 0) {
      clearSelection()
    } else {
      setSelectedTaskIds(filteredTasks.map((t) => t.id))
    }
  }, [selectedTaskIds.length, filteredTasks, clearSelection, setSelectedTaskIds])

  const handleToggleFavorite = useCallback(() => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.includes(t.id))
    const allFavorite = selectedTasks.length > 0 && selectedTasks.every((t) => t.isFavorite)
    const newFavoriteState = !allFavorite
    setConfirmDialog({
      title: newFavoriteState ? '批量收藏' : '批量取消收藏',
      message: newFavoriteState
        ? `确定要收藏选中的 ${selectedTaskIds.length} 条记录吗？`
        : `确定要取消收藏选中的 ${selectedTaskIds.length} 条记录吗？`,
      confirmText: newFavoriteState ? '确认收藏' : '确认取消',
      action: () => {
        selectedTaskIds.forEach((id) => {
          updateTaskInStore(id, { isFavorite: newFavoriteState })
        })
        clearSelection()
      },
    })
  }, [tasks, selectedTaskIds, clearSelection, setConfirmDialog])

  const handleDeleteSelected = useCallback(() => {
    setConfirmDialog({
      title: '批量删除',
      message: `确定要删除选中的 ${selectedTaskIds.length} 条记录吗？`,
      action: () => {
        removeMultipleTasks(selectedTaskIds)
      },
    })
  }, [selectedTaskIds, setConfirmDialog])

  const handleDownloadSelected = useCallback(async () => {
    const selectedTasks = tasks.filter((t) => selectedTaskIds.includes(t.id))
    const imageIds = selectedTasks.flatMap((t) => t.outputImages || [])
    if (imageIds.length === 0) {
      showToast('选中的任务没有生成图片', 'error')
      return
    }
    showToast(`开始下载 ${imageIds.length} 张图片...`, 'info')
    for (const imgId of imageIds) {
      try {
        const dataUrl = await ensureImageCached(imgId)
        if (!dataUrl) continue
        const res = await fetch(dataUrl)
        const blob = await res.blob()
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        const ext = blob.type.split('/')[1] || 'png'
        a.download = `${imgId}.${ext}`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)
      } catch { /* skip failed downloads */ }
    }
    showToast(`已下载 ${imageIds.length} 张图片`, 'success')
  }, [tasks, selectedTaskIds, showToast])

  const handleSaveCurrentTemplate = useCallback(() => {
    if (!prompt.trim()) {
      showToast('请输入提示词后再保存模板', 'error')
      return
    }
    setTemplateEditor({ mode: 'fromCurrent' })
  }, [prompt, setTemplateEditor, showToast])

  const maskDraft = useStore((s) => s.maskDraft)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)

  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const dockStackRef = useRef<HTMLDivElement>(null)
  const imagesRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef(42)

  const [isDragging, setIsDragging] = useState(false)
  const [submitHover, setSubmitHover] = useState(false)
  const [attachHover, setAttachHover] = useState(false)
  const [compressionHintVisible, setCompressionHintVisible] = useState(false)
  const [moderationHintVisible, setModerationHintVisible] = useState(false)
  const [qualityHintVisible, setQualityHintVisible] = useState(false)
  const [optimizingPrompt, setOptimizingPrompt] = useState(false)
  const [mobileCollapsed, setMobileCollapsed] = useState(true)
  const [desktopHovered, setDesktopHovered] = useState(false)
  const [desktopFocused, setDesktopFocused] = useState(false)
  const [desktopDockHeight, setDesktopDockHeight] = useState(0)
  const [showSizePicker, setShowSizePicker] = useState(false)
  const [showExperimentLab, setShowExperimentLab] = useState(false)
  const [maskPreviewUrl, setMaskPreviewUrl] = useState('')
  const handleRef = useRef<HTMLDivElement>(null)
  const dragTouchRef = useRef({ startY: 0, moved: false })
  const compressionHintTimerRef = useRef<number | null>(null)
  const moderationHintTimerRef = useRef<number | null>(null)
  const qualityHintTimerRef = useRef<number | null>(null)
  const [outputCompressionInput, setOutputCompressionInput] = useState(
    params.output_compression == null ? '' : String(params.output_compression),
  )
  const [nInput, setNInput] = useState(String(params.n))
  const dragCounter = useRef(0)
  const isMobile = useIsMobile()
  const desktopExpanded = isMobile || isDragging || desktopHovered || desktopFocused || selectedTaskIds.length > 0
  const desktopCollapsedOffset = isMobile
    ? 0
    : Math.max(0, desktopDockHeight)

  const handleOptimizePrompt = useCallback(() => {
    setOptimizingPrompt(true)
    void optimizeCurrentPrompt().finally(() => setOptimizingPrompt(false))
  }, [])

  const hasGenerationConfig = Boolean(backendUser && settings.channelId && settings.model)
  const missingChannelMessage = canManageSystem(backendUser) ? '请先配置并选择渠道/模型' : '当前没有可用渠道，请联系管理员'
  const canSubmit = Boolean(prompt.trim()) && hasGenerationConfig
  const atImageLimit = inputImages.length >= API_MAX_IMAGES
  const maskTargetImage = maskDraft
    ? inputImages.find((img) => img.id === maskDraft.targetImageId) ?? null
    : null
  const referenceImages = maskTargetImage
    ? inputImages.filter((img) => img.id !== maskTargetImage.id)
    : inputImages

  const handleMissingGenerationConfig = useCallback(() => {
    if (canManageSystem(backendUser)) {
      setShowSettings(true)
    } else {
      showToast(missingChannelMessage, 'error')
    }
  }, [backendUser, missingChannelMessage, setShowSettings, showToast])

  useEffect(() => {
    setOutputCompressionInput(
      params.output_compression == null ? '' : String(params.output_compression),
    )
  }, [params.output_compression])

  useEffect(() => {
    setNInput(String(params.n))
  }, [params.n])

  useEffect(() => {
    if (settings.apiMode === 'responses' && params.moderation !== 'auto') {
      setParams({ moderation: 'auto' })
    }
  }, [params.moderation, settings.apiMode, setParams])

  useEffect(() => {
    if (settings.codexCli && params.quality !== 'auto') {
      setParams({ quality: 'auto' })
    }
  }, [params.quality, settings.codexCli, setParams])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshGenerationPreflight()
    }, 260)
    return () => window.clearTimeout(timer)
  }, [
    inputImages.length,
    maskDraft?.targetImageId,
    params,
    prompt,
    settings.channelId,
    settings.model,
  ])

  useEffect(() => () => {
    if (compressionHintTimerRef.current != null) {
      window.clearTimeout(compressionHintTimerRef.current)
    }
    if (moderationHintTimerRef.current != null) {
      window.clearTimeout(moderationHintTimerRef.current)
    }
    if (qualityHintTimerRef.current != null) {
      window.clearTimeout(qualityHintTimerRef.current)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!maskDraft || !maskTargetImage) {
      setMaskPreviewUrl('')
      return
    }

    createMaskPreviewDataUrl(maskTargetImage.dataUrl, maskDraft.maskDataUrl)
      .then((url) => {
        if (!cancelled) setMaskPreviewUrl(url)
      })
      .catch(() => {
        if (!cancelled) setMaskPreviewUrl('')
      })

    return () => {
      cancelled = true
    }
  }, [maskDraft, maskTargetImage?.id, maskTargetImage?.dataUrl])

  const commitOutputCompression = useCallback(() => {
    if (outputCompressionInput.trim() === '') {
      setOutputCompressionInput('')
      setParams({ output_compression: null })
      return
    }

    const nextValue = Number(outputCompressionInput)
    if (Number.isNaN(nextValue)) {
      setOutputCompressionInput(params.output_compression == null ? '' : String(params.output_compression))
      return
    }

    setOutputCompressionInput(String(nextValue))
    setParams({ output_compression: nextValue })
  }, [outputCompressionInput, params.output_compression, setParams])

  const commitN = useCallback(() => {
    const nextValue = Number(nInput)
    const normalizedValue =
      nInput.trim() === '' ? DEFAULT_PARAMS.n : Number.isNaN(nextValue) ? params.n : nextValue
    setNInput(String(normalizedValue))
    setParams({ n: normalizedValue })
  }, [nInput, params.n, setParams])

  const showModerationHint = () => {
    if (settings.apiMode === 'responses') setModerationHintVisible(true)
  }

  const hideModerationHint = () => {
    setModerationHintVisible(false)
    clearModerationHintTimer()
  }

  const clearModerationHintTimer = () => {
    if (moderationHintTimerRef.current != null) {
      window.clearTimeout(moderationHintTimerRef.current)
      moderationHintTimerRef.current = null
    }
  }

  const startModerationHintTouch = () => {
    if (settings.apiMode !== 'responses') return
    moderationHintTimerRef.current = window.setTimeout(() => {
      setModerationHintVisible(true)
      moderationHintTimerRef.current = null
    }, 450)
  }

  const showCompressionHint = () => setCompressionHintVisible(true)

  const hideCompressionHint = () => {
    setCompressionHintVisible(false)
    clearCompressionHintTimer()
  }

  const clearCompressionHintTimer = () => {
    if (compressionHintTimerRef.current != null) {
      window.clearTimeout(compressionHintTimerRef.current)
      compressionHintTimerRef.current = null
    }
  }

  const startCompressionHintTouch = () => {
    compressionHintTimerRef.current = window.setTimeout(() => {
      setCompressionHintVisible(true)
      compressionHintTimerRef.current = null
    }, 450)
  }

  const showQualityHint = () => {
    if (settings.codexCli) setQualityHintVisible(true)
  }

  const hideQualityHint = () => {
    setQualityHintVisible(false)
    clearQualityHintTimer()
  }

  const clearQualityHintTimer = () => {
    if (qualityHintTimerRef.current != null) {
      window.clearTimeout(qualityHintTimerRef.current)
      qualityHintTimerRef.current = null
    }
  }

  const startQualityHintTouch = () => {
    if (!settings.codexCli) return
    qualityHintTimerRef.current = window.setTimeout(() => {
      setQualityHintVisible(true)
      qualityHintTimerRef.current = null
    }, 450)
  }

  const handleFiles = async (files: FileList | File[]) => {
    try {
      const currentCount = useStore.getState().inputImages.length
      if (currentCount >= API_MAX_IMAGES) {
        useStore.getState().showToast(
          `参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`,
          'error',
        )
        return
      }

      const remaining = API_MAX_IMAGES - currentCount
      const accepted = Array.from(files).filter((f) => f.type.startsWith('image/'))
      const toAdd = accepted.slice(0, remaining)
      const discarded = accepted.length - toAdd.length

      for (const file of toAdd) {
        await addImageFromFile(file)
      }

      if (discarded > 0) {
        useStore.getState().showToast(
          `已达上限 ${API_MAX_IMAGES} 张，${discarded} 张图片被丢弃`,
          'error',
        )
      }
    } catch (err) {
      useStore.getState().showToast(
        `图片添加失败：${err instanceof Error ? err.message : String(err)}`,
        'error',
      )
    }
  }

  const handleFilesRef = useRef(handleFiles)
  handleFilesRef.current = handleFiles

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleFilesRef.current(e.target.files || [])
    e.target.value = ''
  }

  const handleSubmitFromComposer = useCallback(async () => {
    if (!hasGenerationConfig) {
      handleMissingGenerationConfig()
      return
    }
    const queuedTask = await submitTask()
    if (!queuedTask) return
    textareaRef.current?.blur()
    setDesktopFocused(false)
    setDesktopHovered(false)
    setMobileCollapsed(true)
  }, [handleMissingGenerationConfig, hasGenerationConfig])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void handleSubmitFromComposer()
    }
  }

  // 粘贴图片
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items
      if (!items) return
      const imageFiles: File[] = []
      for (const item of Array.from(items)) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile()
          if (file) imageFiles.push(file)
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault()
        handleFilesRef.current(imageFiles)
      }
    }
    document.addEventListener('paste', handlePaste)
    return () => document.removeEventListener('paste', handlePaste)
  }, [])

  // 拖拽图片 - 监听整个页面
  useEffect(() => {
    const handleDragEnter = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current++
      if (e.dataTransfer?.types.includes('Files')) {
        setIsDragging(true)
      }
    }

    const handleDragOver = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
    }

    const handleDragLeave = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current--
      if (dragCounter.current === 0) {
        setIsDragging(false)
      }
    }

    const handleDrop = (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      dragCounter.current = 0
      setIsDragging(false)
      const files = e.dataTransfer?.files
      if (files && files.length > 0) {
        handleFilesRef.current(files)
      }
    }

    document.addEventListener('dragenter', handleDragEnter)
    document.addEventListener('dragover', handleDragOver)
    document.addEventListener('dragleave', handleDragLeave)
    document.addEventListener('drop', handleDrop)

    return () => {
      document.removeEventListener('dragenter', handleDragEnter)
      document.removeEventListener('dragover', handleDragOver)
      document.removeEventListener('dragleave', handleDragLeave)
      document.removeEventListener('drop', handleDrop)
    }
  }, [])

  const adjustTextareaHeight = useCallback(() => {
    const el = textareaRef.current
    if (!el) return

    // 计算图片区域和其他固定元素占用的高度
    const imagesHeight = imagesRef.current?.offsetHeight ?? 0
    const fixedOverhead = imagesHeight + 140

    // textarea 最大高度 = 页面 40% 减去固定开销，至少保留 80px
    const maxH = Math.max(window.innerHeight * 0.4 - fixedOverhead, 80)

    // 1. 关闭过渡动画，设高度为 0 以获取真实的文本内容高度
    el.style.transition = 'none'
    el.style.height = '0'
    el.style.overflowY = 'hidden'
    const scrollH = el.scrollHeight
    const minH = 42
    const desired = Math.max(scrollH, minH)
    const targetH = desired > maxH ? maxH : desired

    // 2. 将高度设回上一次的实际高度，强制重绘，准备开始动画
    el.style.height = prevHeightRef.current + 'px'
    void el.offsetHeight

    // 3. 恢复平滑过渡，并设置目标高度
    el.style.transition = 'height 150ms ease, border-color 200ms, box-shadow 200ms'
    el.style.height = targetH + 'px'
    el.style.overflowY = desired > maxH ? 'auto' : 'hidden'

    prevHeightRef.current = targetH
  }, [])

  useEffect(() => {
    adjustTextareaHeight()
  }, [prompt, adjustTextareaHeight])

  // 图片队列变化时也重新计算
  useEffect(() => {
    adjustTextareaHeight()
  }, [inputImages.length, Boolean(maskDraft), maskPreviewUrl, adjustTextareaHeight])

  useEffect(() => {
    window.addEventListener('resize', adjustTextareaHeight)
    return () => window.removeEventListener('resize', adjustTextareaHeight)
  }, [adjustTextareaHeight])

  useEffect(() => {
    if (isMobile) {
      setDesktopHovered(false)
      setDesktopFocused(false)
      setDesktopDockHeight(0)
      return
    }

    const stack = dockStackRef.current
    if (!stack) return

    const updateHeight = () => {
      setDesktopDockHeight(stack.getBoundingClientRect().height)
    }

    updateHeight()

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateHeight)
      return () => window.removeEventListener('resize', updateHeight)
    }

    const observer = new ResizeObserver(() => updateHeight())
    observer.observe(stack)
    window.addEventListener('resize', updateHeight)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', updateHeight)
    }
  }, [isMobile])

  useEffect(() => {
    if (composerRevealTick === 0) return
    setMobileCollapsed(false)
    setDesktopHovered(true)
    setDesktopFocused(true)
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus()
      const end = textareaRef.current?.value.length ?? 0
      textareaRef.current?.setSelectionRange(end, end)
    })
  }, [composerRevealTick])

  // 移动端拖动条手势
  useEffect(() => {
    const el = handleRef.current
    if (!el) return
    const onTouchStart = (e: TouchEvent) => {
      dragTouchRef.current = { startY: e.touches[0].clientY, moved: false }
    }
    const onTouchMove = (e: TouchEvent) => {
      const dy = e.touches[0].clientY - dragTouchRef.current.startY
      if (Math.abs(dy) > 10) dragTouchRef.current.moved = true
      if (dy > 30) setMobileCollapsed(true)
      if (dy < -30) setMobileCollapsed(false)
    }
    const onTouchEnd = () => {
      if (!dragTouchRef.current.moved) {
        setMobileCollapsed((v) => !v)
      }
    }
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd)
    return () => {
      el.removeEventListener('touchstart', onTouchStart)
      el.removeEventListener('touchmove', onTouchMove)
      el.removeEventListener('touchend', onTouchEnd)
    }
  }, [])

  const handleDesktopBlurCapture = useCallback(() => {
    if (isMobile) return
    window.requestAnimationFrame(() => {
      const dock = dockStackRef.current
      if (!dock?.contains(document.activeElement)) {
        setDesktopFocused(false)
      }
    })
  }, [isMobile])

  const selectClass = 'px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] text-xs transition-all duration-200 shadow-sm'

  const composerImagesElement = (
    <ComposerImages
      inputImages={inputImages}
      removeInputImage={removeInputImage}
      clearInputImages={clearInputImages}
      maskDraft={maskDraft}
      maskPreviewUrl={maskPreviewUrl}
      setMaskEditorImageId={setMaskEditorImageId}
      setLightboxImageId={setLightboxImageId}
      setConfirmDialog={setConfirmDialog}
      maskTargetImage={maskTargetImage}
      referenceImages={referenceImages}
      imagesRef={imagesRef}
    />
  )

  return (
    <>
      {/* 全屏拖拽遮罩 */}
      {isDragging && (
        <div className="fixed inset-0 z-[100] bg-white/60 dark:bg-gray-900/60 backdrop-blur-md flex flex-col items-center justify-center pointer-events-none">
          <div className="flex flex-col items-center gap-4 p-8 rounded-3xl">
            <div className={`w-20 h-20 rounded-full border-2 border-dashed flex items-center justify-center ${
              atImageLimit ? 'bg-red-50 dark:bg-red-500/10 border-red-300' : 'bg-blue-50 dark:bg-blue-500/10 border-blue-400'
            }`}>
              {atImageLimit ? (
                <svg className="w-10 h-10 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
                </svg>
              ) : (
                <svg className="w-10 h-10 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              )}
            </div>
            <div className="text-center">
              {atImageLimit ? (
                <>
                  <p className="text-lg font-semibold text-red-500">已达上限 {API_MAX_IMAGES} 张</p>
                  <p className="text-sm text-gray-400 mt-1">请先移除部分参考图后再添加</p>
                </>
              ) : (
                <>
                  <p className="text-lg font-semibold text-gray-700 dark:text-gray-200">释放以添加参考图</p>
                  <p className="text-sm text-gray-400 mt-1">支持 JPG、PNG、WebP 等格式</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {showSizePicker && (
        <SizePickerModal
          currentSize={params.size}
          onSelect={(size) => setParams({ size })}
          onClose={() => setShowSizePicker(false)}
        />
      )}
      <ExperimentLabModal open={showExperimentLab} onClose={() => setShowExperimentLab(false)} />

      <div
        data-input-bar
        className="pointer-events-none fixed bottom-4 sm:bottom-0 left-1/2 -translate-x-1/2 z-30 w-full max-w-4xl px-3 sm:px-4 transition-all duration-300"
      >
        <div className="relative sm:pb-4">
          {!isMobile && (
            <button
              type="button"
              onFocus={() => setDesktopFocused(true)}
              onMouseEnter={() => setDesktopHovered(true)}
              onMouseLeave={() => setDesktopHovered(false)}
              className={`pointer-events-auto absolute bottom-2 left-1/2 z-10 hidden -translate-x-1/2 items-center gap-2 rounded-full border border-white/50 bg-white/88 px-3 py-1.5 text-xs text-gray-600 shadow-lg shadow-black/10 backdrop-blur dark:border-white/[0.08] dark:bg-gray-900/88 dark:text-gray-300 sm:flex transition-all duration-300 ${
                desktopExpanded ? 'pointer-events-none translate-y-2 opacity-0' : 'translate-y-0 opacity-100'
              }`}
              aria-label="展开提示词输入区"
            >
              <span className="inline-block h-1.5 w-10 rounded-full bg-gray-300 dark:bg-white/[0.14]" />
              <span>提示词输入区</span>
            </button>
          )}

          <div
            ref={dockStackRef}
            className="pointer-events-auto transition-transform duration-300 ease-out will-change-transform"
            onMouseEnter={() => !isMobile && setDesktopHovered(true)}
            onMouseLeave={() => !isMobile && setDesktopHovered(false)}
            onFocusCapture={() => !isMobile && setDesktopFocused(true)}
            onBlurCapture={handleDesktopBlurCapture}
            style={
              isMobile
                ? undefined
                : {
                    transform: `translateY(${desktopExpanded ? 0 : desktopCollapsedOffset}px)`,
                  }
            }
          >
            {selectedTaskIds.length > 0 ? (
              <div className="flex justify-center py-3">
                <div className="bg-gray-800/90 dark:bg-gray-800/90 backdrop-blur shadow-lg rounded-full flex items-center p-1 border border-white/10">
                  <button onClick={clearSelection} className="p-2 text-gray-300 hover:text-white transition-colors" title="取消选择">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                  </button>
                  <div className="w-px h-5 bg-white/20 mx-1"></div>
                  <button onClick={handleSelectAllToggle} className="p-2 text-blue-400 hover:text-blue-300 transition-colors" title={selectedTaskIds.length === filteredTasks.length && filteredTasks.length > 0 ? "取消全选" : "全选当前可见"}>
                    {selectedTaskIds.length === filteredTasks.length && filteredTasks.length > 0 ? (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><path d="M9 12l2 2 4-4" /></svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path strokeDasharray="4 4" d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2z" /></svg>
                    )}
                  </button>
                  <div className="w-px h-5 bg-white/20 mx-1"></div>
                  <button onClick={handleToggleFavorite} className="p-2 text-yellow-400 hover:text-yellow-300 transition-colors" title="收藏/取消收藏">
                    {selectedTaskIds.every((id) => tasks.find((t) => t.id === id)?.isFavorite) ? (
                      <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" /></svg>
                    ) : (
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" /></svg>
                    )}
                  </button>
                  <div className="w-px h-5 bg-white/20 mx-1"></div>
                  <button onClick={handleDeleteSelected} className="p-2 text-red-400 hover:text-red-300 transition-colors" title="删除选中">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                  </button>
                  <div className="w-px h-5 bg-white/20 mx-1"></div>
                  <button onClick={handleDownloadSelected} className="p-2 text-green-400 hover:text-green-300 transition-colors" title="下载选中图片">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
                  </button>
                  <span className="px-2 text-xs text-gray-400">{selectedTaskIds.length} 项</span>
                </div>
              </div>
            ) : (
            <div ref={cardRef} className="bg-white/70 dark:bg-gray-900/70 backdrop-blur-2xl border border-white/50 dark:border-white/[0.08] shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)] rounded-2xl sm:rounded-3xl p-3 sm:p-4 ring-1 ring-black/5 dark:ring-white/10">
          {/* 移动端拖动条 */}
          <div
            ref={handleRef}
            className="sm:hidden flex justify-center pt-0.5 pb-2 -mt-1 cursor-pointer touch-none"
            onClick={() => setMobileCollapsed((v) => !v)}
          >
            <div className={`w-10 h-1 rounded-full bg-gray-300 dark:bg-white/[0.06] transition-transform duration-200 ${mobileCollapsed ? 'scale-x-75' : ''}`} />
          </div>

          {/* 输入图片行（移动端可折叠） */}
          {inputImages.length > 0 && (
            isMobile ? (
              <>
                <div className={`collapse-section${mobileCollapsed ? ' collapsed' : ''}`}>
                  <div className="collapse-inner">
                    {composerImagesElement}
                  </div>
                </div>
                {mobileCollapsed && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mb-2 ml-1">
                    {maskDraft ? `1 张遮罩主图 · ${referenceImages.length} 张参考图` : `${inputImages.length} 张参考图`}
                  </div>
                )}
              </>
            ) : (
              composerImagesElement
            )
          )}

          {activeTemplate && (
            <div className="mb-2 flex items-center gap-2 rounded-xl border border-blue-200/70 bg-blue-50/80 px-3 py-2 text-xs text-blue-700 dark:border-blue-400/20 dark:bg-blue-500/10 dark:text-blue-300">
              <button
                type="button"
                onClick={() => {
                  setCurrentView('templates')
                  setSelectedTemplateId(activeTemplate.id)
                }}
                className="min-w-0 flex-1 truncate text-left font-medium hover:underline"
                title={activeTemplate.title}
              >
                来源模板：{activeTemplate.title}
              </button>
              <button
                type="button"
                onClick={() => setActiveTemplateId(null)}
                className="rounded p-1 hover:bg-blue-100 dark:hover:bg-blue-500/20 transition"
                title="取消模板关联"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}

          {(currentProject || currentProjectId === '__unassigned__' || pendingParentTask) && (
            <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
              {(currentProject || currentProjectId === '__unassigned__') && (
                <span className="inline-flex items-center gap-2 rounded-xl border border-violet-200/70 bg-violet-50/80 px-3 py-2 text-violet-700 dark:border-violet-400/20 dark:bg-violet-500/10 dark:text-violet-300">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: currentProject?.color || '#94a3b8' }} />
                  项目：{currentProject?.name || '未归类'}
                </span>
              )}
              {pendingParentTask && (
                <span className="inline-flex max-w-full items-center gap-2 rounded-xl border border-emerald-200/70 bg-emerald-50/80 px-3 py-2 text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-500/10 dark:text-emerald-300">
                  Remix 来源：<span className="truncate">{pendingParentTask.prompt}</span>
                </span>
              )}
            </div>
          )}

          {generationPreflight && (
            <div className={`mb-2 rounded-xl border px-3 py-2 text-xs ${
              generationPreflight.ok
                ? 'border-gray-200/70 bg-white/60 text-gray-600 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-300'
                : 'border-amber-200/70 bg-amber-50/80 text-amber-700 dark:border-amber-400/20 dark:bg-amber-500/10 dark:text-amber-200'
            }`}>
              <div className="flex flex-wrap items-center gap-2">
                <span>预检</span>
                <span className="rounded-full bg-black/5 px-2 py-0.5 dark:bg-white/[0.06]">
                  {generationPreflight.predictedApiMode}
                </span>
                <span className="rounded-full bg-black/5 px-2 py-0.5 dark:bg-white/[0.06]">
                  {generationPreflight.codexCli ? 'Codex CLI' : '标准 OpenAI'}
                </span>
                {generationPreflight.diagnostics.length > 0 && (
                  <span className="text-gray-400 dark:text-gray-500">
                    {generationPreflight.diagnostics[0].title}
                  </span>
                )}
              </div>
              {generationPreflight.diagnostics.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {generationPreflight.diagnostics.slice(0, 3).map((item) => (
                    <span
                      key={`${item.code}-${item.title}`}
                      className={`rounded-full px-2 py-0.5 ${
                        item.level === 'error'
                          ? 'bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300'
                          : item.level === 'warning'
                          ? 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-200'
                          : 'bg-slate-100 text-slate-600 dark:bg-white/[0.06] dark:text-slate-300'
                      }`}
                    >
                      {item.title}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {prompt.trim() && (
            <details className="mb-2 rounded-xl border border-gray-200/70 bg-white/50 px-3 py-2 text-xs text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400">
              <summary className="cursor-pointer select-none font-medium text-gray-600 dark:text-gray-300">
                最终提示词预览 · {prompt.trim().length} 字
              </summary>
              <p className="mt-2 max-h-28 overflow-y-auto whitespace-pre-wrap break-words leading-5">
                {prompt.trim()}
              </p>
            </details>
          )}

          {/* 输入框 */}
          <textarea
            ref={textareaRef}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="描述你想生成的图片..."
            className="w-full px-4 py-3 rounded-2xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] text-sm focus:outline-none leading-relaxed resize-none shadow-sm transition-[border-color,box-shadow] duration-200"
          />

          {/* 参数 + 按钮 */}
          <div className="mt-3">
            {/* 桌面端布局 */}
            <div className="hidden sm:flex flex-col gap-3">
              <ComposerParams
                settings={settings}
                params={params}
                setParams={setParams}
                channels={channels}
                currentChannel={currentChannel}
                enabledModels={enabledModels}
                selectChannelModel={selectChannelModel}
                codexCli={settings.codexCli}
                showSizePicker={showSizePicker}
                setShowSizePicker={setShowSizePicker}
                compressionHintVisible={compressionHintVisible}
                moderationHintVisible={moderationHintVisible}
                qualityHintVisible={qualityHintVisible}
                showCompressionHint={showCompressionHint}
                hideCompressionHint={hideCompressionHint}
                startCompressionHintTouch={startCompressionHintTouch}
                clearCompressionHintTimer={clearCompressionHintTimer}
                showModerationHint={showModerationHint}
                hideModerationHint={hideModerationHint}
                startModerationHintTouch={startModerationHintTouch}
                clearModerationHintTimer={clearModerationHintTimer}
                showQualityHint={showQualityHint}
                hideQualityHint={hideQualityHint}
                startQualityHintTouch={startQualityHintTouch}
                clearQualityHintTimer={clearQualityHintTimer}
                outputCompressionInput={outputCompressionInput}
                setOutputCompressionInput={setOutputCompressionInput}
                commitOutputCompression={commitOutputCompression}
                nInput={nInput}
                setNInput={setNInput}
                commitN={commitN}
                handleMissingGenerationConfig={handleMissingGenerationConfig}
                selectClass={selectClass}
                missingChannelMessage={missingChannelMessage}
                variant="desktop"
              />

              <div className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-gray-200/60 bg-white/35 px-2.5 py-2 dark:border-white/[0.08] dark:bg-white/[0.02]">
                <div className="flex flex-wrap items-center gap-2">
                  <div
                    className="relative"
                    onMouseEnter={() => setAttachHover(true)}
                    onMouseLeave={() => setAttachHover(false)}
                  >
                    <ButtonTooltip visible={atImageLimit && attachHover} text={`参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`} />
                    <button
                      onClick={() => !atImageLimit && fileInputRef.current?.click()}
                      className={`p-2 rounded-lg transition-all shadow-sm ${
                        atImageLimit
                          ? 'bg-gray-200 dark:bg-white/[0.04] text-gray-300 dark:text-gray-500 cursor-not-allowed'
                          : 'bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 hover:shadow'
                      }`}
                      title={atImageLimit ? `已达上限 ${API_MAX_IMAGES} 张` : '添加参考图'}
                    >
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                      </svg>
                    </button>
                  </div>
                  <button
                    onClick={handleSaveCurrentTemplate}
                    className="p-2 rounded-lg bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 transition-all shadow-sm hover:shadow"
                    title="保存为模板"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-4-7 4z" />
                    </svg>
                  </button>
                  <button
                    onClick={handleOptimizePrompt}
                    disabled={optimizingPrompt || !prompt.trim()}
                    className="hidden sm:flex items-center gap-1.5 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 transition-all shadow-sm hover:shadow disabled:opacity-40 disabled:cursor-not-allowed text-sm font-medium"
                    title="优化提示词"
                  >
                    <svg className={`w-4 h-4 ${optimizingPrompt ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 3 4 14h7l-1 7 9-11h-7l1-7z" />
                    </svg>
                    {optimizingPrompt ? '优化中' : '增强'}
                  </button>
                  <button
                    onClick={handleOptimizePrompt}
                    disabled={optimizingPrompt || !prompt.trim()}
                    className="sm:hidden p-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 transition-all shadow-sm hover:shadow disabled:opacity-40 disabled:cursor-not-allowed"
                    title="优化提示词"
                  >
                    <svg className={`w-5 h-5 ${optimizingPrompt ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 3 4 14h7l-1 7 9-11h-7l1-7z" />
                    </svg>
                  </button>
                  <button
                    onClick={() => setShowExperimentLab(true)}
                    disabled={!prompt.trim()}
                    className="p-2 rounded-lg bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 transition-all shadow-sm hover:shadow disabled:opacity-40 disabled:cursor-not-allowed"
                    title="A/B 对比实验"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M7 12h10M10 17h4" />
                    </svg>
                  </button>
                </div>

                <div
                  className="relative"
                  onMouseEnter={() => setSubmitHover(true)}
                  onMouseLeave={() => setSubmitHover(false)}
                >
                  <ButtonTooltip visible={!hasGenerationConfig && submitHover} text={missingChannelMessage} />
                  <button
                    onClick={() => void handleSubmitFromComposer()}
                    disabled={hasGenerationConfig ? !canSubmit : false}
                    className="inline-flex min-w-[124px] items-center justify-center gap-1.5 rounded-lg bg-blue-500 px-3 py-2 text-sm font-medium text-white transition-all shadow-sm hover:bg-blue-600 hover:shadow disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed"
                    title={hasGenerationConfig ? (maskDraft ? '遮罩编辑 (Ctrl+Enter)' : '生成 (Ctrl+Enter)') : '请先选择渠道和模型'}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    <span>{maskDraft ? '遮罩编辑' : '生成图像'}</span>
                  </button>
                </div>
              </div>
            </div>

            {/* 移动端布局 */}
            <div className="sm:hidden flex flex-col gap-2">
              <div className={`collapse-section${mobileCollapsed ? ' collapsed' : ''}`}>
                <div className="collapse-inner">
                  <ComposerParams
                    settings={settings}
                    params={params}
                    setParams={setParams}
                    channels={channels}
                    currentChannel={currentChannel}
                    enabledModels={enabledModels}
                    selectChannelModel={selectChannelModel}
                    codexCli={settings.codexCli}
                    showSizePicker={showSizePicker}
                    setShowSizePicker={setShowSizePicker}
                    compressionHintVisible={compressionHintVisible}
                    moderationHintVisible={moderationHintVisible}
                    qualityHintVisible={qualityHintVisible}
                    showCompressionHint={showCompressionHint}
                    hideCompressionHint={hideCompressionHint}
                    startCompressionHintTouch={startCompressionHintTouch}
                    clearCompressionHintTimer={clearCompressionHintTimer}
                    showModerationHint={showModerationHint}
                    hideModerationHint={hideModerationHint}
                    startModerationHintTouch={startModerationHintTouch}
                    clearModerationHintTimer={clearModerationHintTimer}
                    showQualityHint={showQualityHint}
                    hideQualityHint={hideQualityHint}
                    startQualityHintTouch={startQualityHintTouch}
                    clearQualityHintTimer={clearQualityHintTimer}
                    outputCompressionInput={outputCompressionInput}
                    setOutputCompressionInput={setOutputCompressionInput}
                    commitOutputCompression={commitOutputCompression}
                    nInput={nInput}
                    setNInput={setNInput}
                    commitN={commitN}
                    handleMissingGenerationConfig={handleMissingGenerationConfig}
                    selectClass={selectClass}
                    missingChannelMessage={missingChannelMessage}
                    variant="mobile"
                  />
                  <div className="h-2" />
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div
                  className="relative"
                  onMouseEnter={() => setAttachHover(true)}
                  onMouseLeave={() => setAttachHover(false)}
                >
                  <ButtonTooltip visible={atImageLimit && attachHover} text={`参考图数量已达上限（${API_MAX_IMAGES} 张），无法继续添加`} />
                  <button
                    onClick={() => !atImageLimit && fileInputRef.current?.click()}
                    className={`p-2.5 rounded-xl transition-all shadow-sm flex-shrink-0 ${
                      atImageLimit
                        ? 'bg-gray-200 dark:bg-white/[0.04] text-gray-300 dark:text-gray-500 cursor-not-allowed'
                        : 'bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300'
                    }`}
                    title={atImageLimit ? `已达上限 ${API_MAX_IMAGES} 张` : '添加参考图'}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  </button>
                </div>
                <button
                  onClick={handleSaveCurrentTemplate}
                  className="p-2.5 rounded-xl bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 transition-all shadow-sm flex-shrink-0"
                  title="保存为模板"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16l-7-4-7 4z" />
                  </svg>
                </button>
                <button
                  onClick={handleOptimizePrompt}
                  disabled={optimizingPrompt || !prompt.trim()}
                  className="p-2.5 rounded-xl bg-amber-50 dark:bg-amber-500/10 hover:bg-amber-100 dark:hover:bg-amber-500/20 text-amber-600 dark:text-amber-400 transition-all shadow-sm flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="优化提示词"
                >
                  <svg className={`w-5 h-5 ${optimizingPrompt ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 3 4 14h7l-1 7 9-11h-7l1-7z" />
                  </svg>
                </button>
                <button
                  onClick={() => setShowExperimentLab(true)}
                  disabled={!prompt.trim()}
                  className="p-2.5 rounded-xl bg-gray-200 dark:bg-white/[0.06] hover:bg-gray-300 dark:hover:bg-white/[0.1] text-gray-500 dark:text-gray-300 transition-all shadow-sm flex-shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                  title="A/B 对比实验"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7h16M7 12h10M10 17h4" />
                  </svg>
                </button>
                <div
                  className="relative flex-1"
                  onMouseEnter={() => setSubmitHover(true)}
                  onMouseLeave={() => setSubmitHover(false)}
                >
            <ButtonTooltip visible={!hasGenerationConfig && submitHover} text={missingChannelMessage} />
                  <button
                    onClick={() => void handleSubmitFromComposer()}
                    disabled={hasGenerationConfig ? !canSubmit : false}
                    className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-medium transition-all shadow-sm bg-blue-500 text-white hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-white/[0.04] disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    {maskDraft ? '遮罩编辑' : '生成图像'}
                  </button>
                </div>
              </div>
            </div>

          </div>

              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={handleFileUpload}
              />
            </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
