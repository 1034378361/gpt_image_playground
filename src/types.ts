// ===== 设置 =====

export type ApiMode = 'images' | 'responses'
export type CodexCliMode = 'auto' | 'standard' | 'codex'
export type ChannelHealthStatus = 'unknown' | 'checking' | 'healthy' | 'degraded' | 'error'
export type ChannelCompatibilityStatus = 'unknown' | 'checking' | 'standard' | 'codex' | 'error'

export interface AppSettings {
  channelId: string
  model: string
  apiMode: ApiMode
  codexCli: boolean
}

export const DEFAULT_SETTINGS: AppSettings = {
  channelId: '',
  model: 'gpt-image-2',
  apiMode: 'images',
  codexCli: false,
}

export interface BackendUser {
  id: string
  username: string
  role: 'user' | 'reviewer' | 'admin'
  createdAt: number
  updatedAt: number
}

export type RegistrationMode = 'disabled' | 'open' | 'invite_only'

export interface AuthSettings {
  registrationMode: RegistrationMode
  allowRegistration: boolean
  inviteCodeRequired: boolean
  hasUsers: boolean
  updatedAt?: number | null
}

export interface InviteCode {
  id: string
  code: string
  note: string
  maxUses?: number | null
  usedCount: number
  remainingUses?: number | null
  isEnabled: boolean
  expiresAt?: number | null
  recentUses: Array<{
    id: string
    userId?: string | null
    username: string
    usedAt: number
  }>
  createdAt: number
  updatedAt: number
}

export interface AdminUser {
  id: string
  username: string
  role: 'user' | 'reviewer' | 'admin'
  createdAt: number
  updatedAt: number
}

export interface ChannelModel {
  id: string
  label: string
  apiMode: ApiMode
  enabled: boolean
}

export interface ApiChannel {
  id: string
  name: string
  models: ChannelModel[]
  timeoutSeconds: number
  codexCli: boolean
  codexCliMode: CodexCliMode
  healthStatus: ChannelHealthStatus
  healthMessage: string
  healthCheckedAt: number | null
  healthLatencyMs: number | null
  compatibilityStatus: ChannelCompatibilityStatus
  compatibilityMessage: string
  compatibilityCheckedAt: number | null
  isEnabled: boolean
  createdAt: number
  updatedAt: number
}

export interface AdminApiChannel extends ApiChannel {
  baseUrl: string
  apiKeyPreview: string
}

export interface ApiChannelDraft {
  name: string
  baseUrl: string
  apiKey: string
  models: ChannelModel[]
  timeoutSeconds: number
  codexCli: boolean
  codexCliMode: CodexCliMode
  isEnabled: boolean
}

export type TemplateVisibility = 'private' | 'public'
export type TemplateSubmissionStatus = 'draft' | 'submitted' | 'approved' | 'rejected'

export interface AuditLog {
  id: string
  actorUserId?: string | null
  actorUsername?: string | null
  action: string
  resourceType: string
  resourceId?: string | null
  details: Record<string, unknown>
  createdAt: number
}

export interface GenerationQueueStats {
  workerCount: number
  queuedCount: number
  runningCount: number
  yourQueuedCount: number
  yourRunningCount: number
}

export interface SystemBackupPreview {
  version: number
  exportedAt?: number | null
  tableCounts: Record<string, number>
  assetFileCount: number
  hasAdminUser: boolean
  totalRecords: number
}

export interface ProjectBoard {
  id: string
  name: string
  description: string
  color: string
  isArchived: boolean
  taskCount: number
  templateCount: number
  createdAt: number
  updatedAt: number
}

export interface ProjectBoardDraft {
  name: string
  description: string
  color: string
  isArchived?: boolean
}

// ===== 任务参数 =====

export interface TaskParams {
  size: string
  quality: 'auto' | 'low' | 'medium' | 'high'
  output_format: 'png' | 'jpeg' | 'webp'
  output_compression: number | null
  moderation: 'auto' | 'low'
  n: number
}

export const DEFAULT_PARAMS: TaskParams = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}

export interface GenerationDiagnostic {
  code: string
  level: 'info' | 'warning' | 'error'
  title: string
  detail: string
  hint?: string
}

export interface GenerationPreflight {
  ok: boolean
  predictedApiMode: ApiMode
  codexCli: boolean
  normalizedParams: TaskParams
  diagnostics: GenerationDiagnostic[]
}

// ===== 提示词模板 =====

export interface TemplateFormField {
  key: string
  label: string
  type: 'text' | 'textarea' | 'select' | 'color' | 'number' | 'image'
  required: boolean
  defaultValue: string
  options: string[]
  placeholder: string
  helpText: string
}

export interface PromptTemplate {
  id: string
  userId?: string | null
  projectId?: string | null
  title: string
  description: string
  prompt: string
  negativePrompt?: string
  tags: string[]
  category: string
  params: TaskParams
  channelId?: string | null
  apiMode: ApiMode
  model: string
  coverImageId?: string | null
  externalCoverUrl?: string | null
  exampleImages: string[]
  recommendedChannelId?: string | null
  recommendedApiMode?: ApiMode | null
  recommendedModel?: string
  linkedTaskIds: string[]
  isFavorite: boolean
  sourceName?: string
  sourceUrl?: string
  sourceAuthor?: string
  licenseName?: string
  formFields: TemplateFormField[]
  collections: string[]
  isFeatured: boolean
  visibility: TemplateVisibility
  submissionStatus: TemplateSubmissionStatus
  submittedAt?: number | null
  reviewedAt?: number | null
  reviewedBy?: string | null
  rejectionReason?: string | null
  favoriteCount: number
  usageCount: number
  successCount: number
  failureCount: number
  ratingCount: number
  averageRating: number
  lastUsedAt?: number | null
  qualityScore: number
  version: number
  createdAt: number
  updatedAt: number
}

export interface PromptTemplateDraft {
  title: string
  description: string
  prompt: string
  negativePrompt?: string
  tags: string[]
  category: string
  params: TaskParams
  channelId?: string | null
  apiMode: ApiMode
  model: string
  coverImageId?: string | null
  externalCoverUrl?: string | null
  exampleImages?: string[]
  recommendedChannelId?: string | null
  recommendedApiMode?: ApiMode | null
  recommendedModel?: string
  linkedTaskIds?: string[]
  isFavorite?: boolean
  sourceName?: string
  sourceUrl?: string
  sourceAuthor?: string
  licenseName?: string
  projectId?: string | null
  formFields?: TemplateFormField[]
  collections?: string[]
  isFeatured?: boolean
}

export interface TemplateFilters {
  query: string
  category: string
  tag: string
  favoriteOnly: boolean
  scope: 'all' | 'public' | 'discover' | 'review'
  sort: 'updated' | 'popular' | 'quality' | 'used'
  collection: string
}

export interface OpenPromptSourceStatus {
  id: string
  label: string
  repoUrl: string
  licenseName: string
  importedCount: number
  lastSyncedAt?: number | null
  lastCreated: number
  lastUpdated: number
  lastSkipped: number
}

export interface OpenPromptPreviewItem {
  key: string
  title: string
  prompt: string
  image: string
  sourceUrl: string
  sourceAuthor: string
  sourceName: string
  licenseName: string
  category: string
  tags: string[]
  qualityScore: number
  isDuplicate: boolean
}

export interface OpenPromptPreview {
  source: string
  label: string
  licenseName: string
  repoUrl: string
  total: number
  loaded: number
  truncated: boolean
  newCount: number
  duplicateCount: number
  highQualityCount: number
  highQualityNewCount: number
  items: OpenPromptPreviewItem[]
}

export interface TemplateSample {
  imageId: string
  taskId?: string | null
  templateId: string
  templateVersionId?: string | null
  prompt: string
  params: TaskParams
  channelId?: string | null
  apiMode?: ApiMode | null
  model?: string | null
  width?: number | null
  height?: number | null
  elapsed?: number | null
  createdAt: number
}

export interface TemplateVersion {
  id: string
  templateId: string
  version: number
  snapshot: Partial<PromptTemplate>
  createdBy?: string | null
  createdAt: number
}

export interface PromptOptimizeResult {
  prompt: string
  method: 'local' | 'responses'
  changed: boolean
}

export interface ChannelLeaderboardItem {
  channelId?: string | null
  channelName: string
  model: string
  apiMode?: ApiMode | null
  totalCount: number
  successCount: number
  failureCount: number
  successRate: number
  averageElapsed?: number | null
  lastUsedAt?: number | null
  healthStatus: ChannelHealthStatus
  compatibilityStatus: ChannelCompatibilityStatus
}

// ===== 输入图片（UI 层面） =====

export interface InputImage {
  /** IndexedDB image store 的 id（SHA-256 hash） */
  id: string
  /** data URL，用于预览 */
  dataUrl: string
}

export interface MaskDraft {
  targetImageId: string
  maskDataUrl: string
  updatedAt: number
}

// ===== 任务记录 =====

export type TaskStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

export interface TaskRecord {
  id: string
  /** 来源模板 id */
  templateId?: string
  /** 来源模板版本，预留给后端/未来模板版本管理 */
  templateVersionId?: string
  projectId?: string | null
  parentTaskId?: string | null
  experimentId?: string | null
  variationLabel?: string | null
  prompt: string
  params: TaskParams
  /** API 返回的实际生效参数，用于标记与请求值不一致的情况 */
  actualParams?: Partial<TaskParams>
  /** 输出图片对应的实际生效参数，key 为 outputImages 中的图片 id */
  actualParamsByImage?: Record<string, Partial<TaskParams>>
  /** 输出图片对应的 API 改写提示词，key 为 outputImages 中的图片 id */
  revisedPromptByImage?: Record<string, string>
  /** 输入图片的 image store id 列表 */
  inputImageIds: string[]
  maskTargetImageId?: string | null
  maskImageId?: string | null
  /** 输出图片的 image store id 列表 */
  outputImages: string[]
  status: TaskStatus
  error: string | null
  createdAt: number
  finishedAt: number | null
  /** 总耗时毫秒 */
  elapsed: number | null
  /** 是否收藏 */
  isFavorite?: boolean
  diagnostics?: GenerationDiagnostic[]
  channelId?: string | null
  apiMode?: ApiMode | null
  model?: string | null
}

// ===== IndexedDB 存储的图片 =====

export interface StoredImage {
  id: string
  dataUrl: string
  /** 图片首次存储时间（ms） */
  createdAt?: number
  /** 最近一次访问时间（ms），用于 LRU 淘汰 */
  lastAccessedAt?: number
  /** 图片来源：用户上传 / API 生成 / 遮罩 */
  source?: 'upload' | 'generated' | 'mask'
}

export interface ServerAsset {
  id: string
  userId: string
  taskId?: string | null
  templateId?: string | null
  type: string
  mime: string
  width?: number | null
  height?: number | null
  sizeBytes: number
  hasThumbnail?: boolean
  visualHash?: string | null
  createdAt: number
}

// ===== API 请求体 =====

export interface ImageGenerationRequest {
  model: string
  prompt: string
  size: string
  quality: string
  output_format: string
  moderation: string
  output_compression?: number
  n?: number
}

// ===== 导出数据 =====

/** ZIP manifest.json 格式 */
export interface ExportData {
  version: number
  exportedAt: string
  settings: AppSettings
  tasks: TaskRecord[]
  templates?: PromptTemplate[]
  /** imageId → 图片信息 */
  imageFiles: Record<string, {
    path: string
    createdAt?: number
    source?: 'upload' | 'generated' | 'mask'
  }>
}
