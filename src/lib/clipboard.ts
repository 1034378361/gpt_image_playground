export async function copyTextToClipboard(text: string) {
  let asyncClipboardError: unknown = null
  const normalizedText = String(text ?? '')

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(normalizedText)
      return
    } catch (err) {
      asyncClipboardError = err
    }
  }

  if (copyTextWithExecCommand(normalizedText)) return

  throw asyncClipboardError ?? new Error('Clipboard API is not available')
}

export async function copyBlobToClipboard(blob: Blob) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    if (await copyImageWithExecCommand(blob)) return
    throw new Error('Clipboard image API is not available')
  }

  const pngBlob = await normalizeImageBlobForClipboard(blob)
  const clipboardItem = new ClipboardItem({ 'image/png': pngBlob })
  let clipboardWriteError: unknown = null

  try {
    await navigator.clipboard.write([clipboardItem])
    const verified = await verifyClipboardHasImage()
    if (verified !== false) return
  } catch (err) {
    clipboardWriteError = err
  }

  if (await copyImageWithExecCommand(pngBlob)) {
    const verified = await verifyClipboardHasImage()
    if (verified !== false) return
  }

  throw clipboardWriteError ?? new Error('Clipboard write completed without image data')
}

export function getClipboardFailureMessage(fallback: string, err: unknown) {
  if (isEmbeddedPage() && isClipboardPermissionError(err)) {
    return '复制失败：内嵌页面未授予剪贴板权限'
  }

  return fallback
}

function copyTextWithExecCommand(text: string) {
  const textarea = document.createElement('textarea')
  const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const selection = document.getSelection()
  const previousRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []

  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.setAttribute('aria-hidden', 'true')
  textarea.tabIndex = -1
  textarea.style.position = 'fixed'
  textarea.style.left = '0'
  textarea.style.top = '0'
  textarea.style.width = '1px'
  textarea.style.height = '1px'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'

  document.body.appendChild(textarea)
  textarea.focus({ preventScroll: true })
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    document.body.removeChild(textarea)
    if (selection) {
      selection.removeAllRanges()
      for (const range of previousRanges) selection.addRange(range)
    }
    activeElement?.focus({ preventScroll: true })
  }
}

async function normalizeImageBlobForClipboard(blob: Blob): Promise<Blob> {
  if (!blob.type.startsWith('image/')) {
    throw new Error('Clipboard payload is not an image')
  }
  if (blob.type === 'image/png') return blob
  return convertImageBlobToPng(blob)
}

async function convertImageBlobToPng(blob: Blob): Promise<Blob> {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D context is not available')

  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob)
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    ctx.drawImage(bitmap, 0, 0)
    bitmap.close()
  } else {
    const image = await loadImageFromBlob(blob)
    canvas.width = image.naturalWidth || image.width
    canvas.height = image.naturalHeight || image.height
    ctx.drawImage(image, 0, 0)
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((pngBlob) => {
      if (pngBlob) resolve(pngBlob)
      else reject(new Error('Failed to encode image as PNG'))
    }, 'image/png')
  })
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      resolve(image)
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Failed to decode image'))
    }
    image.src = url
  })
}

async function verifyClipboardHasImage(): Promise<boolean | null> {
  if (!navigator.clipboard?.read) return null
  try {
    const items = await navigator.clipboard.read()
    return items.some((item) => item.types.some((type) => type === 'image/png' || type.startsWith('image/')))
  } catch {
    return null
  }
}

async function copyImageWithExecCommand(blob: Blob): Promise<boolean> {
  let url = ''
  let container: HTMLDivElement | null = null
  const activeElement = typeof document !== 'undefined' && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null
  const selection = typeof document !== 'undefined' ? document.getSelection() : null
  const previousRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    : []
  try {
    if (!blob.type.startsWith('image/') || typeof document === 'undefined') return false
    url = URL.createObjectURL(blob)
    container = document.createElement('div')
    const image = document.createElement('img')
    container.contentEditable = 'true'
    container.setAttribute('aria-hidden', 'true')
    container.style.position = 'fixed'
    container.style.left = '0'
    container.style.top = '0'
    container.style.width = '1px'
    container.style.height = '1px'
    container.style.overflow = 'hidden'
    container.style.opacity = '0'
    container.style.pointerEvents = 'none'
    image.src = url
    image.alt = ''
    container.appendChild(image)
    document.body.appendChild(container)
    await waitForImageDecode(image)
    const range = document.createRange()
    range.selectNode(image)
    selection?.removeAllRanges()
    selection?.addRange(range)
    container.focus({ preventScroll: true })
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    if (container?.parentNode) document.body.removeChild(container)
    if (url) URL.revokeObjectURL(url)
    if (selection) {
      selection.removeAllRanges()
      for (const range of previousRanges) selection.addRange(range)
    }
    activeElement?.focus({ preventScroll: true })
  }
}

function waitForImageDecode(image: HTMLImageElement): Promise<void> {
  if (image.complete && image.naturalWidth > 0) return Promise.resolve()
  if (image.decode) {
    return image.decode().catch(() => waitForImageLoad(image))
  }
  return waitForImageLoad(image)
}

function waitForImageLoad(image: HTMLImageElement): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('Failed to load image for clipboard copy'))
  })
}

function isEmbeddedPage() {
  try {
    return window.self !== window.top
  } catch {
    return true
  }
}

function isClipboardPermissionError(err: unknown) {
  if (!(err instanceof Error)) return false

  return (
    err.name === 'NotAllowedError' ||
    /permission|permissions policy|not allowed|denied/i.test(err.message)
  )
}
