import type {
  AppSettings,
  BackendUser,
  PromptTemplate,
  PromptTemplateDraft,
  ServerAsset,
  TaskRecord,
} from '../types'

function apiBase(settings: AppSettings): string {
  const base = settings.backendUrl.trim().replace(/\/+$/, '')
  return base ? `${base}/api` : '/api'
}

async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json()
    if (typeof body.detail === 'string') return body.detail
    if (body.detail) return JSON.stringify(body.detail)
    if (typeof body.message === 'string') return body.message
  } catch {
    try {
      return await response.text()
    } catch {
      /* ignore */
    }
  }
  return `HTTP ${response.status}`
}

async function request<T>(settings: AppSettings, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase(settings)}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(init.headers ?? {}),
    },
  })

  if (!response.ok) {
    throw new Error(await readError(response))
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

export function getMe(settings: AppSettings): Promise<BackendUser> {
  return request(settings, '/auth/me')
}

export function login(settings: AppSettings, username: string, password: string): Promise<BackendUser> {
  return request(settings, '/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function register(settings: AppSettings, username: string, password: string): Promise<BackendUser> {
  return request(settings, '/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export function logout(settings: AppSettings): Promise<{ ok: boolean }> {
  return request(settings, '/auth/logout', { method: 'POST' })
}

export function listTemplates(settings: AppSettings): Promise<PromptTemplate[]> {
  return request(settings, '/templates')
}

export function createTemplate(settings: AppSettings, template: PromptTemplateDraft): Promise<PromptTemplate> {
  return request(settings, '/templates', {
    method: 'POST',
    body: JSON.stringify(template),
  })
}

export function patchTemplate(
  settings: AppSettings,
  templateId: string,
  patch: Partial<PromptTemplateDraft>,
): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export function deleteTemplate(settings: AppSettings, templateId: string): Promise<{ ok: boolean }> {
  return request(settings, `/templates/${templateId}`, { method: 'DELETE' })
}

export function duplicateTemplate(settings: AppSettings, templateId: string): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}/duplicate`, { method: 'POST' })
}

export function setTemplateCover(settings: AppSettings, templateId: string, imageId: string): Promise<PromptTemplate> {
  return request(settings, `/templates/${templateId}/set-cover`, {
    method: 'POST',
    body: JSON.stringify({ imageId }),
  })
}

export function listGenerations(settings: AppSettings): Promise<TaskRecord[]> {
  return request(settings, '/generations')
}

export function getGeneration(settings: AppSettings, taskId: string): Promise<TaskRecord> {
  return request(settings, `/generations/${taskId}`)
}

export function deleteGeneration(settings: AppSettings, taskId: string): Promise<{ ok: boolean }> {
  return request(settings, `/generations/${taskId}`, { method: 'DELETE' })
}

export async function getAssetDataUrl(settings: AppSettings, assetId: string): Promise<string> {
  const response = await fetch(`${apiBase(settings)}/assets/${assetId}`, {
    credentials: 'include',
  })
  if (!response.ok) throw new Error(await readError(response))
  const blob = await response.blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
}

export interface BackendGenerateRequest {
  taskId?: string
  templateId?: string
  templateVersionId?: string
  settings: AppSettings
  prompt: string
  params: TaskRecord['params']
  inputImageDataUrls: string[]
  maskDataUrl?: string
}

export interface BackendGenerateResponse {
  task: TaskRecord
  images: string[]
  outputAssets: ServerAsset[]
  actualParams?: Record<string, unknown> | null
  actualParamsList?: Array<Record<string, unknown> | null> | null
  revisedPrompts?: Array<string | null> | null
}

export function generate(settings: AppSettings, payload: BackendGenerateRequest): Promise<BackendGenerateResponse> {
  return request(settings, '/generate', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function runGeneration(settings: AppSettings, payload: BackendGenerateRequest): Promise<{ task: TaskRecord }> {
  return request(settings, '/generations/run', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}
