from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field

ApiMode = Literal["images", "responses"]
TaskStatus = Literal["running", "done", "error"]


class UserOut(BaseModel):
    id: str
    username: str
    role: str
    createdAt: int
    updatedAt: int


class AuthIn(BaseModel):
    username: str = Field(min_length=3, max_length=64)
    password: str = Field(min_length=8, max_length=256)


class TaskParams(BaseModel):
    size: str = "auto"
    quality: Literal["auto", "low", "medium", "high"] = "auto"
    output_format: Literal["png", "jpeg", "webp"] = "png"
    output_compression: int | None = None
    moderation: Literal["auto", "low"] = "auto"
    n: int = 1


class PromptTemplateIn(BaseModel):
    title: str
    description: str = ""
    prompt: str
    negativePrompt: str | None = None
    tags: list[str] = Field(default_factory=list)
    category: str = ""
    params: TaskParams
    apiMode: ApiMode
    model: str
    coverImageId: str | None = None
    linkedTaskIds: list[str] = Field(default_factory=list)
    isFavorite: bool = False


class PromptTemplatePatch(BaseModel):
    title: str | None = None
    description: str | None = None
    prompt: str | None = None
    negativePrompt: str | None = None
    tags: list[str] | None = None
    category: str | None = None
    params: TaskParams | None = None
    apiMode: ApiMode | None = None
    model: str | None = None
    coverImageId: str | None = None
    linkedTaskIds: list[str] | None = None
    isFavorite: bool | None = None


class PromptTemplateOut(PromptTemplateIn):
    id: str
    userId: str
    version: int
    createdAt: int
    updatedAt: int


class SetCoverIn(BaseModel):
    imageId: str


class GenerationTaskIn(BaseModel):
    id: str | None = None
    templateId: str | None = None
    templateVersionId: str | None = None
    prompt: str
    params: TaskParams
    inputImageIds: list[str] = Field(default_factory=list)
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
    apiMode: ApiMode | None = None
    model: str | None = None


class GenerationTaskPatch(BaseModel):
    templateId: str | None = None
    templateVersionId: str | None = None
    prompt: str | None = None
    params: TaskParams | None = None
    inputImageIds: list[str] | None = None
    outputImages: list[str] | None = None
    actualParams: dict[str, Any] | None = None
    actualParamsByImage: dict[str, dict[str, Any]] | None = None
    revisedPromptByImage: dict[str, str] | None = None
    status: TaskStatus | None = None
    error: str | None = None
    finishedAt: int | None = None
    elapsed: int | None = None
    isFavorite: bool | None = None


class GenerationTaskOut(BaseModel):
    id: str
    userId: str
    templateId: str | None = None
    templateVersionId: str | None = None
    prompt: str
    params: TaskParams
    inputImageIds: list[str]
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
    createdAt: int


class ProxySettings(BaseModel):
    baseUrl: str | None = None
    apiKey: str | None = None
    model: str
    timeout: int = 300
    apiMode: ApiMode
    codexCli: bool = False


class GenerateIn(BaseModel):
    taskId: str | None = None
    templateId: str | None = None
    templateVersionId: str | None = None
    settings: ProxySettings
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
