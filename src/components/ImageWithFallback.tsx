import { useEffect, useState, type ImgHTMLAttributes, type MouseEvent } from 'react'

type Props = Omit<ImgHTMLAttributes<HTMLImageElement>, 'alt' | 'onError' | 'src'> & {
  src: string
  alt?: string
  fallbackClassName?: string
  fallbackLabel?: string
}

export default function ImageWithFallback({
  src,
  alt = '',
  className,
  fallbackClassName,
  fallbackLabel = '图片加载失败',
  ...imgProps
}: Props) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const [retryCount, setRetryCount] = useState(0)

  useEffect(() => {
    setFailedSrc(null)
  }, [src])

  function retry(event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    setRetryCount((count) => count + 1)
    setFailedSrc(null)
  }

  if (failedSrc === src) {
    return (
      <div className={fallbackClassName ?? 'flex h-full w-full flex-col items-center justify-center gap-2 bg-gray-50 p-3 text-center text-xs text-gray-400 dark:bg-black/20 dark:text-gray-500'}>
        <svg className="h-7 w-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="m3 16 4-4a3 3 0 0 1 4.2 0l.8.8a3 3 0 0 0 4.2 0L21 8m-3-4H6a3 3 0 0 0-3 3v10a3 3 0 0 0 3 3h12a3 3 0 0 0 3-3V7a3 3 0 0 0-3-3Z" />
        </svg>
        <span>{fallbackLabel}</span>
        <button
          type="button"
          onClick={retry}
          className="rounded-full bg-white/80 px-3 py-1 text-[11px] text-blue-600 shadow-sm ring-1 ring-gray-200 transition hover:bg-blue-50 dark:bg-white/[0.08] dark:text-blue-300 dark:ring-white/[0.08] dark:hover:bg-white/[0.14]"
        >
          重新加载
        </button>
      </div>
    )
  }

  return (
    <img
      {...imgProps}
      key={`${src}-${retryCount}`}
      src={src}
      alt={alt}
      className={className}
      onError={() => setFailedSrc(src)}
    />
  )
}
