from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ApiMode = Literal["images", "responses"]
CodexCliMode = Literal["auto", "standard", "codex"]
ChannelHealthStatus = Literal["unknown", "checking", "healthy", "degraded", "error"]
ChannelCompatibilityStatus = Literal["unknown", "checking", "standard", "codex", "error"]
TaskStatus = Literal["queued", "running", "done", "error", "canceled"]
UserRole = Literal["user", "reviewer", "admin"]
TemplateVisibility = Literal["private", "public"]
TemplateSubmissionStatus = Literal["draft", "submitted", "approved", "rejected"]
RegistrationMode = Literal["disabled", "open", "invite_only"]


class GenerationDiagnosticOut(BaseModel):
    code: str
    level: Literal["info", "warning", "error"] = "info"
    title: str
    detail: str
    hint: str | None = None


class TemplateFormField(BaseModel):
    key: str
    label: str
    type: Literal["text", "textarea", "select", "color", "number", "image"] = "text"
    required: bool = True
    defaultValue: str = ""
    options: list[str] = Field(default_factory=list)
    placeholder: str = ""
    helpText: str = ""


class ProjectBoardIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    description: str = Field(default="", max_length=500)
    color: str = Field(default="#3b82f6", max_length=16)
    isArchived: bool = False


class ProjectBoardPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    description: str | None = Field(default=None, max_length=500)
    color: str | None = Field(default=None, max_length=16)
    isArchived: bool | None = None


class ProjectBoardOut(BaseModel):
    id: str
    name: str
    description: str = ""
    color: str = "#3b82f6"
    isArchived: bool = False
    taskCount: int = 0
    templateCount: int = 0
    createdAt: int
    updatedAt: int


class UserOut(BaseModel):
    id: str
    username: str
    role: UserRole
    createdAt: int
    updatedAt: int


class UserRolePatchIn(BaseModel):
    role: UserRole


class AuthIn(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=256)


class AuthRegisterIn(AuthIn):
    inviteCode: str | None = Field(default=None, max_length=128)


class AuthSettingsOut(BaseModel):
    registrationMode: RegistrationMode = "open"
    allowRegistration: bool = True
    inviteCodeRequired: bool = False
    hasUsers: bool = False
    updatedAt: int | None = None


class AuthSettingsPatch(BaseModel):
    registrationMode: RegistrationMode | None = None


class InviteCodeIn(BaseModel):
    note: str = Field(default="", max_length=120)
    maxUses: int | None = Field(default=None, ge=1, le=100000)
    expiresAt: int | None = None


class InviteCodeBatchIn(InviteCodeIn):
    count: int = Field(default=10, ge=1, le=200)


class InviteCodePatch(BaseModel):
    note: str | None = Field(default=None, max_length=120)
    maxUses: int | None = Field(default=None, ge=1, le=100000)
    expiresAt: int | None = None
    isEnabled: bool | None = None


class InviteCodeUseOut(BaseModel):
    id: str
    userId: str | None = None
    username: str = ""
    usedAt: int


class InviteCodeOut(BaseModel):
    id: str
    code: str
    note: str = ""
    maxUses: int | None = None
    usedCount: int = 0
    remainingUses: int | None = None
    isEnabled: bool = True
    expiresAt: int | None = None
    recentUses: list[InviteCodeUseOut] = Field(default_factory=list)
    createdAt: int
    updatedAt: int


class TaskParams(BaseModel):
    size: str = "auto"
    quality: Literal["auto", "low", "medium", "high"] = "auto"
    output_format: Literal["png", "jpeg", "webp"] = "png"
    output_compression: int | None = None
    moderation: Literal["auto", "low"] = "auto"
    n: int = 1


class ChannelModel(BaseModel):
    id: str
    label: str = ""
    apiMode: ApiMode = "images"
    enabled: bool = True


class ApiChannelIn(BaseModel):
    name: str
    baseUrl: str
    apiKey: str
    models: list[ChannelModel] = Field(default_factory=list)
    timeoutSeconds: int = 300
    codexCli: bool = False
    codexCliMode: CodexCliMode = "auto"
    isEnabled: bool = True


class ApiChannelPatch(BaseModel):
    name: str | None = None
    baseUrl: str | None = None
    apiKey: str | None = None
    models: list[ChannelModel] | None = None
    timeoutSeconds: int | None = None
    codexCli: bool | None = None
    codexCliMode: CodexCliMode | None = None
    isEnabled: bool | None = None


class ApiChannelOut(BaseModel):
    id: str
    name: str
    models: list[ChannelModel]
    timeoutSeconds: int = 300
    codexCli: bool = False
    codexCliMode: CodexCliMode = "auto"
    healthStatus: ChannelHealthStatus = "unknown"
    healthMessage: str = ""
    healthCheckedAt: int | None = None
    healthLatencyMs: int | None = None
    compatibilityStatus: ChannelCompatibilityStatus = "unknown"
    compatibilityMessage: str = ""
    compatibilityCheckedAt: int | None = None
    isEnabled: bool = True
    createdAt: int
    updatedAt: int


class AdminApiChannelOut(ApiChannelOut):
    baseUrl: str
    apiKeyPreview: str = ""


class AuditLogOut(BaseModel):
    id: str
    actorUserId: str | None = None
    actorUsername: str | None = None
    action: str
    resourceType: str
    resourceId: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)
    createdAt: int


class GenerationQueueStatsOut(BaseModel):
    workerCount: int = 1
    queuedCount: int = 0
    runningCount: int = 0
    yourQueuedCount: int = 0
    yourRunningCount: int = 0


class SystemBackupPreviewOut(BaseModel):
    version: int = 1
    exportedAt: int | None = None
    tableCounts: dict[str, int] = Field(default_factory=dict)
    assetFileCount: int = 0
    hasAdminUser: bool = False
    totalRecords: int = 0


class SystemBackupImportOut(BaseModel):
    ok: bool = True
    restorePointName: str = ""


class PromptTemplateIn(BaseModel):
    projectId: str | None = None
    title: str
    description: str = ""
    prompt: str
    negativePrompt: str | None = None
    tags: list[str] = Field(default_factory=list)
    category: str = ""
    params: TaskParams
    channelId: str | None = None
    apiMode: ApiMode
    model: str
    coverImageId: str | None = None
    externalCoverUrl: str | None = None
    exampleImages: list[str] = Field(default_factory=list)
    recommendedChannelId: str | None = None
    recommendedApiMode: ApiMode | None = None
    recommendedModel: str = ""
    linkedTaskIds: list[str] = Field(default_factory=list)
    isFavorite: bool = False
    sourceName: str = ""
    sourceUrl: str = ""
    sourceAuthor: str = ""
    licenseName: str = ""
    formFields: list[TemplateFormField] = Field(default_factory=list)
    collections: list[str] = Field(default_factory=list)
    isFeatured: bool = False


class PromptTemplatePatch(BaseModel):
    projectId: str | None = None
    title: str | None = None
    description: str | None = None
    prompt: str | None = None
    negativePrompt: str | None = None
    tags: list[str] | None = None
    category: str | None = None
    params: TaskParams | None = None
    channelId: str | None = None
    apiMode: ApiMode | None = None
    model: str | None = None
    coverImageId: str | None = None
    externalCoverUrl: str | None = None
    exampleImages: list[str] | None = None
    recommendedChannelId: str | None = None
    recommendedApiMode: ApiMode | None = None
    recommendedModel: str | None = None
    linkedTaskIds: list[str] | None = None
    isFavorite: bool | None = None
    sourceName: str | None = None
    sourceUrl: str | None = None
    sourceAuthor: str | None = None
    licenseName: str | None = None
    formFields: list[TemplateFormField] | None = None
    collections: list[str] | None = None
    isFeatured: bool | None = None


class PromptTemplateOut(PromptTemplateIn):
    id: str
    userId: str
    visibility: TemplateVisibility = "private"
    submissionStatus: TemplateSubmissionStatus = "draft"
    submittedAt: int | None = None
    reviewedAt: int | None = None
    reviewedBy: str | None = None
    rejectionReason: str | None = None
    favoriteCount: int = 0
    usageCount: int = 0
    successCount: int = 0
    failureCount: int = 0
    ratingCount: int = 0
    averageRating: float = 0
    lastUsedAt: int | None = None
    qualityScore: float = 0
    version: int
    createdAt: int
    updatedAt: int


class SetCoverIn(BaseModel):
    imageId: str


class RejectTemplateIn(BaseModel):
    reason: str = ""


class RateTemplateIn(BaseModel):
    score: int = Field(ge=1, le=5)


class TemplateSampleOut(BaseModel):
    imageId: str
    taskId: str | None = None
    templateId: str
    templateVersionId: str | None = None
    prompt: str = ""
    params: TaskParams
    channelId: str | None = None
    apiMode: ApiMode | None = None
    model: str | None = None
    width: int | None = None
    height: int | None = None
    elapsed: int | None = None
    createdAt: int


class TemplateVersionOut(BaseModel):
    id: str
    templateId: str
    version: int
    snapshot: dict[str, Any]
    createdBy: str | None = None
    createdAt: int


class PromptOptimizeIn(BaseModel):
    channelId: str | None = None
    model: str | None = None
    prompt: str
    negativePrompt: str | None = None


class PromptOptimizeOut(BaseModel):
    prompt: str
    method: Literal["local", "responses"] = "local"
    changed: bool = False


class GenerationPreflightIn(BaseModel):
    channelId: str
    model: str
    prompt: str
    params: TaskParams
    inputImageCount: int = 0
    hasMask: bool = False


class GenerationPreflightOut(BaseModel):
    ok: bool = True
    predictedApiMode: ApiMode
    codexCli: bool = False
    normalizedParams: TaskParams
    diagnostics: list[GenerationDiagnosticOut] = Field(default_factory=list)


class TemplatePackImportIn(BaseModel):
    templates: list[dict[str, Any]] = Field(default_factory=list)


class TemplatePackImportOut(BaseModel):
    ok: bool = True
    created: int = 0
    skipped: int = 0


class ChannelLeaderboardOut(BaseModel):
    channelId: str | None = None
    channelName: str = ""
    model: str = ""
    apiMode: ApiMode | None = None
    totalCount: int = 0
    successCount: int = 0
    failureCount: int = 0
    successRate: float = 0
    averageElapsed: int | None = None
    lastUsedAt: int | None = None
    healthStatus: ChannelHealthStatus = "unknown"
    compatibilityStatus: ChannelCompatibilityStatus = "unknown"


class OpenPromptSourceOut(BaseModel):
    id: str
    label: str
    repoUrl: str
    licenseName: str
    importedCount: int = 0
    lastSyncedAt: int | None = None
    lastCreated: int = 0
    lastUpdated: int = 0
    lastSkipped: int = 0


class OpenPromptPreviewItemOut(BaseModel):
    key: str
    title: str
    prompt: str
    image: str = ""
    sourceUrl: str = ""
    sourceAuthor: str = ""
    sourceName: str = ""
    licenseName: str = ""
    category: str = ""
    tags: list[str] = Field(default_factory=list)
    qualityScore: float = 0
    isDuplicate: bool = False


class OpenPromptPreviewOut(BaseModel):
    source: str
    label: str
    licenseName: str
    repoUrl: str
    total: int
    loaded: int = 0
    truncated: bool = False
    newCount: int = 0
    duplicateCount: int = 0
    highQualityCount: int = 0
    highQualityNewCount: int = 0
    items: list[OpenPromptPreviewItemOut]


class OpenPromptImportIn(BaseModel):
    source: str = "evolink"
    limit: int = 0
    selectedKeys: list[str] = Field(default_factory=list)


class AutoImportSettingsPatch(BaseModel):
    enabled: bool | None = None
    runHour: int | None = Field(default=None, ge=0, le=23)
    githubToken: str | None = None
    searchQueries: list[str] | None = None
    trustedRepos: list[str] | None = None
    includeKnownSources: bool | None = None
    autoApproveTrusted: bool | None = None
    maxRepositories: int | None = Field(default=None, ge=1, le=50)
    maxTemplatesPerRun: int | None = Field(default=None, ge=1, le=300)
    minHotScore: float | None = Field(default=None, ge=0, le=10000)


class AutoImportSettingsOut(BaseModel):
    enabled: bool = False
    runHour: int = 3
    githubTokenPreview: str = ""
    searchQueries: list[str] = Field(default_factory=list)
    trustedRepos: list[str] = Field(default_factory=list)
    includeKnownSources: bool = True
    autoApproveTrusted: bool = False
    maxRepositories: int = 12
    maxTemplatesPerRun: int = 80
    minHotScore: float = 20
    lastRunAt: int | None = None
    nextRunAt: int | None = None
    updatedAt: int | None = None


class AutoImportRunOut(BaseModel):
    id: str
    status: Literal["running", "done", "error"]
    trigger: Literal["manual", "scheduled"]
    startedAt: int
    finishedAt: int | None = None
    discoveredRepositories: int = 0
    selectedRepositories: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    submitted: int = 0
    approved: int = 0
    message: str = ""
    details: dict[str, Any] = Field(default_factory=dict)


class OpenPromptDiscoveryOut(BaseModel):
    id: str
    sourceId: str
    label: str
    repoUrl: str
    description: str = ""
    stars: int = 0
    forks: int = 0
    hotScore: float = 0
    promptCount: int = 0
    licenseName: str = ""
    lastSeenAt: int
    lastImportedAt: int | None = None
    lastStatus: str = ""
    lastMessage: str = ""


class GenerationTaskIn(BaseModel):
    id: str | None = None
    templateId: str | None = None
    templateVersionId: str | None = None
    projectId: str | None = None
    parentTaskId: str | None = None
    experimentId: str | None = None
    variationLabel: str | None = None
    prompt: str
    params: TaskParams
    inputImageIds: list[str] = Field(default_factory=list)
    maskTargetImageId: str | None = None
    maskImageId: str | None = None
    outputImages: list[str] = Field(default_factory=list)
    actualParams: dict[str, Any] | None = None
    actualParamsByImage: dict[str, dict[str, Any]] | None = None
    revisedPromptByImage: dict[str, str] | None = None
    status: TaskStatus = "done"
    error: str | None = None
    createdAt: int | None = None
    finishedAt: int | None = None
    elapsed: int | None = None
    isFavorite: bool = False
    diagnostics: list[GenerationDiagnosticOut] = Field(default_factory=list)
    channelId: str | None = None
    apiMode: ApiMode | None = None
    model: str | None = None


class GenerationTaskPatch(BaseModel):
    templateId: str | None = None
    templateVersionId: str | None = None
    projectId: str | None = None
    parentTaskId: str | None = None
    experimentId: str | None = None
    variationLabel: str | None = None
    prompt: str | None = None
    params: TaskParams | None = None
    inputImageIds: list[str] | None = None
    maskTargetImageId: str | None = None
    maskImageId: str | None = None
    outputImages: list[str] | None = None
    actualParams: dict[str, Any] | None = None
    actualParamsByImage: dict[str, dict[str, Any]] | None = None
    revisedPromptByImage: dict[str, str] | None = None
    status: TaskStatus | None = None
    error: str | None = None
    finishedAt: int | None = None
    elapsed: int | None = None
    isFavorite: bool | None = None
    diagnostics: list[GenerationDiagnosticOut] | None = None
    channelId: str | None = None
    apiMode: ApiMode | None = None
    model: str | None = None


class GenerationTaskOut(BaseModel):
    id: str
    userId: str
    templateId: str | None = None
    templateVersionId: str | None = None
    projectId: str | None = None
    parentTaskId: str | None = None
    experimentId: str | None = None
    variationLabel: str | None = None
    prompt: str
    params: TaskParams
    inputImageIds: list[str]
    maskTargetImageId: str | None = None
    maskImageId: str | None = None
    outputImages: list[str]
    actualParams: dict[str, Any] | None = None
    actualParamsByImage: dict[str, dict[str, Any]] | None = None
    revisedPromptByImage: dict[str, str] | None = None
    status: TaskStatus
    error: str | None = None
    createdAt: int
    finishedAt: int | None = None
    elapsed: int | None = None
    isFavorite: bool = False
    diagnostics: list[GenerationDiagnosticOut] = Field(default_factory=list)
    channelId: str | None = None
    apiMode: ApiMode | None = None
    model: str | None = None


class AssetOut(BaseModel):
    id: str
    userId: str
    taskId: str | None = None
    templateId: str | None = None
    type: str
    mime: str
    width: int | None = None
    height: int | None = None
    sizeBytes: int
    hasThumbnail: bool = False
    visualHash: str | None = None
    createdAt: int


class GenerateIn(BaseModel):
    taskId: str | None = None
    templateId: str | None = None
    templateVersionId: str | None = None
    projectId: str | None = None
    parentTaskId: str | None = None
    experimentId: str | None = None
    variationLabel: str | None = None
    channelId: str
    model: str
    prompt: str
    params: TaskParams
    inputImageDataUrls: list[str] = Field(default_factory=list)
    maskDataUrl: str | None = None


class GenerateOut(BaseModel):
    task: GenerationTaskOut
    images: list[str]
    outputAssets: list[AssetOut]
    actualParams: dict[str, Any] | None = None
    actualParamsList: list[dict[str, Any] | None] | None = None
    revisedPrompts: list[str | None] | None = None


class GenerateRunOut(BaseModel):
    task: GenerationTaskOut
