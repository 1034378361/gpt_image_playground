import { useEffect, useState } from 'react'
import { ensureImageCached, getCachedImage } from '../store'

function sameImageSrcs(a: Record<string, string>, b: Record<string, string>) {
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  return aKeys.length === bKeys.length && aKeys.every((key) => a[key] === b[key])
}

export function useCachedImageMap(ids: Array<string | null | undefined>) {
  const [imageSrcs, setImageSrcs] = useState<Record<string, string>>({})
  const idKey = ids.filter((id): id is string => Boolean(id)).join('\0')

  useEffect(() => {
    const normalizedIds = idKey ? [...new Set(idKey.split('\0'))] : []
    if (!normalizedIds.length) {
      setImageSrcs((prev) => (Object.keys(prev).length ? {} : prev))
      return
    }

    let cancelled = false
    const initial: Record<string, string> = {}
    for (const id of normalizedIds) {
      const cached = getCachedImage(id)
      if (cached) initial[id] = cached
    }
    setImageSrcs((prev) => (sameImageSrcs(prev, initial) ? prev : initial))

    for (const id of normalizedIds) {
      if (initial[id]) continue
      ensureImageCached(id).then((url) => {
        if (!cancelled && url) {
          setImageSrcs((prev) => (prev[id] === url ? prev : { ...prev, [id]: url }))
        }
      })
    }

    return () => {
      cancelled = true
    }
  }, [idKey])

  return imageSrcs
}
