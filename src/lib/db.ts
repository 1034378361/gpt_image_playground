import type { PromptTemplate, TaskRecord, StoredImage } from '../types'

const DB_NAME = 'gpt-image-playground'
const DB_VERSION = 2
const STORE_TASKS = 'tasks'
const STORE_IMAGES = 'images'
const STORE_TEMPLATES = 'templates'

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result
      if (!db.objectStoreNames.contains(STORE_TASKS)) {
        db.createObjectStore(STORE_TASKS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_TEMPLATES)) {
        db.createObjectStore(STORE_TEMPLATES, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function dbTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode)
        const store = tx.objectStore(storeName)
        const req = fn(store)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

// ===== Tasks =====

export function getAllTasks(): Promise<TaskRecord[]> {
  return dbTransaction(STORE_TASKS, 'readonly', (s) => s.getAll())
}

export function putTask(task: TaskRecord): Promise<IDBValidKey> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.put(task))
}

export function deleteTask(id: string): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.delete(id))
}

export function clearTasks(): Promise<undefined> {
  return dbTransaction(STORE_TASKS, 'readwrite', (s) => s.clear())
}

// ===== Prompt templates =====

export function getAllTemplates(): Promise<PromptTemplate[]> {
  return dbTransaction(STORE_TEMPLATES, 'readonly', (s) => s.getAll())
}

export function putTemplate(template: PromptTemplate): Promise<IDBValidKey> {
  return dbTransaction(STORE_TEMPLATES, 'readwrite', (s) => s.put(template))
}

export function clearTemplates(): Promise<undefined> {
  return dbTransaction(STORE_TEMPLATES, 'readwrite', (s) => s.clear())
}

// ===== Images =====

const IMAGE_CACHE_MAX = 200

export async function getImage(id: string): Promise<StoredImage | undefined> {
  const image = await dbTransaction(STORE_IMAGES, 'readonly', (s) => s.get(id)) as StoredImage | undefined
  if (image) {
    image.lastAccessedAt = Date.now()
    void dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.put(image))
  }
  return image
}

export function getAllImages(): Promise<StoredImage[]> {
  return dbTransaction(STORE_IMAGES, 'readonly', (s) => s.getAll())
}

export function putImage(image: StoredImage): Promise<IDBValidKey> {
  return dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.put({ ...image, lastAccessedAt: image.lastAccessedAt ?? Date.now() }))
}

export function deleteImage(id: string): Promise<undefined> {
  return dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.delete(id))
}

export function clearImages(): Promise<undefined> {
  return dbTransaction(STORE_IMAGES, 'readwrite', (s) => s.clear())
}

export async function evictOldImages(referencedIds: Set<string>): Promise<number> {
  const all = await getAllImages()
  if (all.length <= IMAGE_CACHE_MAX) return 0

  const evictable = all
    .filter((img) => img.source === 'generated' && !referencedIds.has(img.id))
    .sort((a, b) => (a.lastAccessedAt ?? a.createdAt ?? 0) - (b.lastAccessedAt ?? b.createdAt ?? 0))

  const toEvict = evictable.slice(0, all.length - IMAGE_CACHE_MAX)
  for (const img of toEvict) {
    await deleteImage(img.id)
  }
  return toEvict.length
}

// ===== Image hashing & dedup =====

export async function hashDataUrl(dataUrl: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    return hashDataUrlFallback(dataUrl)
  }

  const data = new TextEncoder().encode(dataUrl)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function hashDataUrlFallback(dataUrl: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193

  for (let i = 0; i < dataUrl.length; i++) {
    const code = dataUrl.charCodeAt(i)
    h1 ^= code
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= code
    h2 = Math.imul(h2, 0x27d4eb2d)
  }

  return `fallback-${(h1 >>> 0).toString(16).padStart(8, '0')}${(h2 >>> 0).toString(16).padStart(8, '0')}`
}

/**
 * 存储图片，若已存在（按 hash 去重）则跳过。
 * 返回 image id。
 */
export async function storeImage(dataUrl: string, source: NonNullable<StoredImage['source']> = 'upload'): Promise<string> {
  const id = await hashDataUrl(dataUrl)
  const existing = await getImage(id)
  if (!existing) {
    await putImage({ id, dataUrl, createdAt: Date.now(), source })
  }
  return id
}
