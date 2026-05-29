import { describe, expect, it } from 'vitest'
import { shouldCollapseComposer } from './composerCollapse'

describe('composer collapse behavior', () => {
  it('keeps the desktop composer open while focus remains inside', () => {
    expect(shouldCollapseComposer({
      isMobile: false,
      hasFocusInside: true,
      isComposingPrompt: false,
    })).toBe(false)
  })

  it('keeps the desktop composer open during IME composition', () => {
    expect(shouldCollapseComposer({
      isMobile: false,
      hasFocusInside: false,
      isComposingPrompt: true,
    })).toBe(false)
  })

  it('collapses only after desktop focus and composition both leave the composer', () => {
    expect(shouldCollapseComposer({
      isMobile: false,
      hasFocusInside: false,
      isComposingPrompt: false,
    })).toBe(true)
  })

  it('does not use desktop auto-collapse behavior on mobile', () => {
    expect(shouldCollapseComposer({
      isMobile: true,
      hasFocusInside: false,
      isComposingPrompt: false,
    })).toBe(false)
  })
})
