import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyBlobToClipboard, copyTextToClipboard } from './clipboard'

describe('clipboard utilities', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('falls back to focused textarea copy when async clipboard is denied', async () => {
    class FakeHTMLElement {
      focus = vi.fn()
    }

    const activeElement = new FakeHTMLElement()
    const range = { cloneRange: vi.fn(() => range) }
    const selection = {
      rangeCount: 1,
      getRangeAt: vi.fn(() => range),
      removeAllRanges: vi.fn(),
      addRange: vi.fn(),
    }
    const textarea = {
      value: '',
      setAttribute: vi.fn(),
      style: {} as Record<string, string>,
      tabIndex: 0,
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
    }
    const writeText = vi.fn().mockRejectedValue(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    const appendChild = vi.fn()
    const removeChild = vi.fn()
    const execCommand = vi.fn(() => true)

    vi.stubGlobal('HTMLElement', FakeHTMLElement)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    vi.stubGlobal('document', {
      activeElement,
      body: { appendChild, removeChild },
      createElement: vi.fn(() => textarea),
      execCommand,
      getSelection: vi.fn(() => selection),
    })

    await expect(copyTextToClipboard('hello prompt')).resolves.toBeUndefined()

    expect(writeText).toHaveBeenCalledWith('hello prompt')
    expect(appendChild).toHaveBeenCalledWith(textarea)
    expect(textarea.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(textarea.select).toHaveBeenCalled()
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, 'hello prompt'.length)
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(removeChild).toHaveBeenCalledWith(textarea)
    expect(selection.addRange).toHaveBeenCalledWith(range)
    expect(activeElement.focus).toHaveBeenCalledWith({ preventScroll: true })
  })

  it('writes image blobs as PNG and verifies image data exists on the clipboard', async () => {
    class FakeClipboardItem {
      types: string[]
      items: Record<string, Blob>

      constructor(items: Record<string, Blob>) {
        this.items = items
        this.types = Object.keys(items)
      }
    }

    const write = vi.fn()
    const read = vi.fn(async () => [{ types: ['image/png'] }])
    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    vi.stubGlobal('navigator', { clipboard: { write, read } })

    const blob = new Blob(['png'], { type: 'image/png' })
    await expect(copyBlobToClipboard(blob)).resolves.toBeUndefined()

    expect(write).toHaveBeenCalledOnce()
    const [[items]] = write.mock.calls
    expect(items[0]).toBeInstanceOf(FakeClipboardItem)
    expect(items[0].types).toEqual(['image/png'])
    expect(items[0].items['image/png']).toBe(blob)
    expect(read).toHaveBeenCalledOnce()
  })

  it('does not report success when image clipboard write cannot be verified', async () => {
    class FakeClipboardItem {
      types: string[]

      constructor(items: Record<string, Blob>) {
        this.types = Object.keys(items)
      }
    }

    vi.stubGlobal('ClipboardItem', FakeClipboardItem)
    vi.stubGlobal('navigator', {
      clipboard: {
        write: vi.fn(),
        read: vi.fn(async () => []),
      },
    })

    await expect(copyBlobToClipboard(new Blob(['png'], { type: 'image/png' }))).rejects.toThrow(
      'Clipboard write completed without image data',
    )
  })
})
