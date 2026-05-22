import React, { useEffect, useState, useRef } from 'react'
import { useStore, addImageFromUrl } from '../store'
import { setTemplateCover } from '../storeTemplateActions'
import { copyBlobToClipboard, getClipboardFailureMessage } from '../lib/clipboard'
import { copyAssetToSystemClipboard, listSimilarTemplates } from '../lib/backendApi'

export default function ImageContextMenu() {
  const [menuInfo, setMenuInfo] = useState<{ src: string; x: number; y: number; imageId?: string; templateId?: string } | null>(null)
  const showToast = useStore((s) => s.showToast)
  const settings = useStore((s) => s.settings)
  const inputImages = useStore((s) => s.inputImages)
  const setDetailTaskId = useStore((s) => s.setDetailTaskId)
  const setLightboxImageId = useStore((s) => s.setLightboxImageId)
  const setMaskEditorImageId = useStore((s) => s.setMaskEditorImageId)
  const setCurrentView = useStore((s) => s.setCurrentView)
  const setSelectedTemplateId = useStore((s) => s.setSelectedTemplateId)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isEmbeddedPage()) return

    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (target && target.tagName === 'IMG') {
        const imgTarget = target as HTMLImageElement
        // 忽略没有 src 或空的 img
        if (!imgTarget.src) return

        e.preventDefault()
        setMenuInfo({
          src: imgTarget.src,
          x: e.clientX,
          y: e.clientY,
          imageId: imgTarget.dataset.imageId,
          templateId: imgTarget.dataset.templateId,
        })
      }
    }

    // 监听全局 contextmenu，兼容桌面端右键和大部分移动端长按
    window.addEventListener('contextmenu', onContextMenu)
    return () => {
      window.removeEventListener('contextmenu', onContextMenu)
    }
  }, [])

  // 点击其他地方、滚动或缩放时关闭菜单
  useEffect(() => {
    if (!menuInfo) return
    const close = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) {
        return
      }
      if (e.target instanceof Element && e.target.closest('[data-lightbox-root]')) {
        window.dispatchEvent(new Event('image-context-menu-dismiss-lightbox-click'))
      }
      setMenuInfo(null)
    }
    window.addEventListener('mousedown', close, { capture: true })
    window.addEventListener('touchstart', close, { capture: true })
    window.addEventListener('wheel', close, { capture: true })
    window.addEventListener('scroll', close, { capture: true })
    window.addEventListener('resize', close)
    return () => {
      window.removeEventListener('mousedown', close, { capture: true })
      window.removeEventListener('touchstart', close, { capture: true })
      window.removeEventListener('wheel', close, { capture: true })
      window.removeEventListener('scroll', close, { capture: true })
      window.removeEventListener('resize', close)
    }
  }, [menuInfo])

  if (!menuInfo) return null

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const copyTarget = menuInfo
    setMenuInfo(null)
    if (!copyTarget) return
    try {
      if (copyTarget.imageId) {
        await copyAssetToSystemClipboard(settings, copyTarget.imageId)
        showToast('图片已复制到系统剪贴板', 'success')
        return
      }
      const res = await fetch(copyTarget.src)
      const blob = await res.blob()
      await copyBlobToClipboard(blob)
      showToast('图片已复制', 'success')
    } catch (err) {
      console.error(err)
      try {
        const res = await fetch(copyTarget.src)
        const blob = await res.blob()
        await copyBlobToClipboard(blob)
        showToast(copyTarget.imageId ? '系统剪贴板失败，已复制到浏览器剪贴板' : '图片已复制', copyTarget.imageId ? 'error' : 'success')
      } catch (fallbackErr) {
        console.error(fallbackErr)
        showToast(getClipboardFailureMessage('复制失败', fallbackErr), 'error')
      }
    }
  }

  const handleDownload = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuInfo(null)
    try {
      const res = await fetch(menuInfo.src)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ext = blob.type.split('/')[1] || 'png'
      a.download = `image-${Date.now()}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      showToast('开始下载', 'success')
    } catch (err) {
      console.error(err)
      showToast('下载失败', 'error')
    }
  }

  const handleEdit = async (e: React.MouseEvent) => {
    e.stopPropagation()
    setMenuInfo(null)
    if (inputImages.length >= 16) {
      showToast('参考图数量已达上限（16 张），无法继续添加', 'error')
      return
    }

    try {
      await addImageFromUrl(menuInfo.src)
      setDetailTaskId(null)
      setLightboxImageId(null)
      setMaskEditorImageId(null)
      showToast('已加入参考图', 'success')
    } catch (err) {
      console.error(err)
      showToast(`加入参考图失败：${err instanceof Error ? err.message : String(err)}`, 'error')
    }
  }

  const handleSetCover = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!menuInfo.imageId || !menuInfo.templateId) return
    const { imageId, templateId } = menuInfo
    setMenuInfo(null)
    try {
      await setTemplateCover(templateId, imageId)
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const handleFindSimilar = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!menuInfo.imageId) return
    const imageId = menuInfo.imageId
    setMenuInfo(null)
    try {
      const matches = await listSimilarTemplates(settings, { assetId: imageId, limit: 8 })
      if (!matches.length) {
        showToast('没有找到相似模板', 'info')
        return
      }
      setLightboxImageId(null)
      setDetailTaskId(null)
      setCurrentView('templates')
      setSelectedTemplateId(matches[0].id)
      showToast(`找到 ${matches.length} 个相似模板`, 'success')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  // 保证菜单在视口内
  let left = menuInfo.x
  let top = menuInfo.y
  const MENU_WIDTH = 120
  const MENU_HEIGHT = menuInfo.imageId && menuInfo.templateId ? 208 : menuInfo.imageId ? 168 : 128

  if (left + MENU_WIDTH > window.innerWidth) {
    left -= MENU_WIDTH
  }
  if (top + MENU_HEIGHT > window.innerHeight) {
    top -= MENU_HEIGHT
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-100 dark:border-gray-700 py-1 w-[120px] overflow-hidden animate-fade-in"
      style={{ left, top }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        onClick={handleCopy}
        className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
      >
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
        复制
      </button>
      <button
        onClick={handleDownload}
        className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
      >
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
        下载
      </button>
      <button
        onClick={handleEdit}
        className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
      >
        <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
        </svg>
        编辑
      </button>
      {menuInfo.imageId && menuInfo.templateId && (
        <button
          onClick={handleSetCover}
          className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
        >
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4-4 4 4 8-8" />
          </svg>
          设封面
        </button>
      )}
      {menuInfo.imageId && (
        <button
          onClick={handleFindSimilar}
          className="w-full px-4 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 flex items-center gap-2 transition-colors"
        >
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15z" />
          </svg>
          相似
        </button>
      )}
    </div>
  )
}

function isEmbeddedPage() {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}
