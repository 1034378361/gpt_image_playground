import type { InputImage, MaskDraft } from '../types'

export interface ComposerImagesProps {
  inputImages: InputImage[]
  removeInputImage: (index: number) => void
  clearInputImages: () => void
  maskDraft: MaskDraft | null
  maskPreviewUrl: string
  setMaskEditorImageId: (id: string) => void
  setLightboxImageId: (id: string, ids: string[]) => void
  setConfirmDialog: (dialog: {
    title: string
    message: string
    confirmText?: string
    action: () => void
  }) => void
  maskTargetImage: InputImage | null
  referenceImages: InputImage[]
  imagesRef: React.RefObject<HTMLDivElement | null>
}

export default function ComposerImages(props: ComposerImagesProps) {
  const {
    inputImages,
    removeInputImage,
    clearInputImages,
    maskDraft,
    maskPreviewUrl,
    setMaskEditorImageId,
    setLightboxImageId,
    setConfirmDialog,
    maskTargetImage,
    referenceImages,
    imagesRef,
  } = props

  const renderImageThumb = (img: InputImage) => {
    const originalIndex = inputImages.findIndex((i) => i.id === img.id)
    const isMaskTarget = maskDraft?.targetImageId === img.id
    const canEdit = !maskTargetImage || isMaskTarget
    const displaySrc = isMaskTarget && maskPreviewUrl ? maskPreviewUrl : img.dataUrl

    return (
      <div key={img.id} className="relative group inline-block">
        <div
          className={`relative w-[52px] h-[52px] rounded-xl overflow-hidden border shadow-sm cursor-pointer ${
            isMaskTarget ? 'border-blue-500 border-2' : 'border-gray-200 dark:border-white/[0.08]'
          }`}
          onClick={() => setLightboxImageId(img.id, inputImages.map((i) => i.id))}
        >
          <img
            src={displaySrc}
            className="w-full h-full object-cover hover:opacity-90 transition-opacity"
            alt=""
          />
          {isMaskTarget && (
            <span className="absolute left-1 top-1 rounded bg-blue-500/90 px-1.5 py-0.5 text-[8px] leading-none text-white font-bold tracking-wider backdrop-blur-sm z-10 pointer-events-none">
              MASK
            </span>
          )}
          {canEdit && (
            <button
              className="absolute inset-0 w-full h-full bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center cursor-pointer z-20 focus:outline-none border-none"
              onClick={(e) => {
                e.stopPropagation()
                setMaskEditorImageId(img.id)
              }}
              title={isMaskTarget ? "编辑遮罩" : "添加遮罩"}
            >
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </button>
          )}
        </div>
        <span
          className="absolute -top-2 -right-2 w-[22px] h-[22px] rounded-full bg-red-500 text-white flex items-center justify-center cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity shadow-md hover:bg-red-600 z-30"
          onClick={(e) => {
            e.stopPropagation()
            if (originalIndex >= 0) removeInputImage(originalIndex)
          }}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </span>
      </div>
    )
  }

  const renderClearAllButton = () => (
    <button
      onClick={() =>
        setConfirmDialog({
          title: maskTargetImage ? '清空全部输入图' : '清空参考图',
          message: maskTargetImage
            ? `确定要清空遮罩主图、${referenceImages.length} 张参考图和当前遮罩吗？`
            : `确定要清空全部 ${inputImages.length} 张参考图吗？`,
          action: () => clearInputImages(),
        })
      }
      className="w-[52px] h-[52px] rounded-xl border border-dashed border-gray-300 dark:border-white/[0.08] flex flex-col items-center justify-center gap-0.5 text-gray-400 dark:text-gray-500 hover:text-red-500 hover:border-red-300 hover:bg-red-50/50 dark:hover:bg-red-950/30 transition-all cursor-pointer flex-shrink-0"
      title={maskTargetImage ? '清空遮罩主图、参考图和遮罩' : '清空全部参考图'}
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
      <span className="text-[8px] leading-none">{maskTargetImage ? '清空全部' : '清空'}</span>
    </button>
  )

  return (
    <div ref={imagesRef}>
      <div className="grid grid-cols-[repeat(auto-fill,52px)] justify-between gap-x-2 gap-y-3 mb-3">
        {inputImages.map((img) => renderImageThumb(img))}
        {renderClearAllButton()}
      </div>
    </div>
  )
}
