export interface ComposerCollapseState {
  isMobile: boolean
  hasFocusInside: boolean
  isComposingPrompt: boolean
}

export function shouldCollapseComposer(state: ComposerCollapseState) {
  return !state.isMobile && !state.hasFocusInside && !state.isComposingPrompt
}
