import Select from './Select'
import { normalizeImageSize } from '../lib/size'
import { compatibilityStatusLabel, healthStatusLabel } from '../lib/channelHealth'
import type { TaskParams, AppSettings, ApiChannel, ChannelModel } from '../types'
import { DEFAULT_PARAMS } from '../types'

/** 通用悬浮气泡提示 */
function ButtonTooltip({ visible, text }: { visible: boolean; text: string }) {
  if (!visible) return null
  return (
    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 pointer-events-none z-10 whitespace-nowrap">
      <div className="relative bg-gray-800 text-white text-xs rounded-lg px-3 py-2 shadow-lg">
        {text}
        <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-800" />
      </div>
    </div>
  )
}

export interface ComposerParamsProps {
  settings: AppSettings
  params: TaskParams
  setParams: (patch: Partial<TaskParams>) => void
  channels: ApiChannel[]
  currentChannel: ApiChannel | null
  enabledModels: ChannelModel[]
  selectChannelModel: (channelId: string, modelId?: string) => void
  codexCli: boolean
  showSizePicker: boolean
  setShowSizePicker: (v: boolean) => void
  compressionHintVisible: boolean
  moderationHintVisible: boolean
  qualityHintVisible: boolean
  showCompressionHint: () => void
  hideCompressionHint: () => void
  startCompressionHintTouch: () => void
  clearCompressionHintTimer: () => void
  showModerationHint: () => void
  hideModerationHint: () => void
  startModerationHintTouch: () => void
  clearModerationHintTimer: () => void
  showQualityHint: () => void
  hideQualityHint: () => void
  startQualityHintTouch: () => void
  clearQualityHintTimer: () => void
  outputCompressionInput: string
  setOutputCompressionInput: (v: string) => void
  commitOutputCompression: () => void
  nInput: string
  setNInput: (v: string) => void
  commitN: () => void
  handleMissingGenerationConfig: () => void
  selectClass: string
  missingChannelMessage: string
  variant: 'desktop' | 'mobile'
}

const labelClass = 'text-gray-400 dark:text-gray-500 ml-1'

export default function ComposerParams(props: ComposerParamsProps) {
  const {
    settings,
    params,
    setParams,
    channels,
    currentChannel,
    enabledModels,
    selectChannelModel,
    codexCli,
    setShowSizePicker,
    compressionHintVisible,
    moderationHintVisible,
    qualityHintVisible,
    showCompressionHint,
    hideCompressionHint,
    startCompressionHintTouch,
    clearCompressionHintTimer,
    showModerationHint,
    hideModerationHint,
    startModerationHintTouch,
    clearModerationHintTimer,
    showQualityHint,
    hideQualityHint,
    startQualityHintTouch,
    clearQualityHintTimer,
    outputCompressionInput,
    setOutputCompressionInput,
    commitOutputCompression,
    nInput,
    setNInput,
    commitN,
    handleMissingGenerationConfig,
    selectClass,
    missingChannelMessage,
    variant,
  } = props

  const channelField = (
    <label className="flex flex-col gap-0.5">
      <span className={labelClass}>渠道</span>
      <Select
        value={settings.channelId || '__none__'}
        onChange={(value) => {
          if (value === '__none__') {
            handleMissingGenerationConfig()
            return
          }
          selectChannelModel(String(value))
        }}
        options={
          channels.length
            ? channels.map((channel) => ({
                label: `${channel.name} · ${healthStatusLabel(channel.healthStatus)} · ${compatibilityStatusLabel(channel.compatibilityStatus)}`,
                value: channel.id,
              }))
            : [{ label: missingChannelMessage, value: '__none__' }]
        }
        className={selectClass}
      />
    </label>
  )

  const modelField = (
    <label className="flex flex-col gap-0.5">
      <span className={labelClass}>模型</span>
      <Select
        value={settings.model || '__none__'}
        onChange={(value) => {
          if (!settings.channelId || value === '__none__') return
          selectChannelModel(settings.channelId, String(value))
        }}
        options={
          enabledModels.length
            ? enabledModels.map((model) => ({ label: model.label || model.id, value: model.id }))
            : [{ label: currentChannel ? '当前渠道暂无可用模型' : '请先选择渠道', value: '__none__' }]
        }
        className={selectClass}
        disabled={!currentChannel || !enabledModels.length}
      />
    </label>
  )

  const sizeField = (
    <label className="flex flex-col gap-0.5">
      <span className={labelClass}>尺寸</span>
      <button
        type="button"
        onClick={() => setShowSizePicker(true)}
        className="px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] hover:bg-white dark:hover:bg-white/[0.06] focus:outline-none text-xs text-left transition-all duration-200 shadow-sm font-mono"
        title="选择尺寸"
      >
        {normalizeImageSize(params.size) || DEFAULT_PARAMS.size}
      </button>
    </label>
  )

  const qualityField = (
    <label
      className="relative flex flex-col gap-0.5"
      onMouseEnter={showQualityHint}
      onMouseLeave={hideQualityHint}
      onTouchStart={startQualityHintTouch}
      onTouchEnd={clearQualityHintTimer}
      onTouchCancel={hideQualityHint}
      onClick={showQualityHint}
    >
      <span className={labelClass}>质量</span>
      <Select
        value={codexCli ? 'auto' : params.quality}
        onChange={(val) => {
          if (!codexCli) setParams({ quality: val as any })
        }}
        options={[
          { label: 'auto', value: 'auto' },
          { label: 'low', value: 'low' },
          { label: 'medium', value: 'medium' },
          { label: 'high', value: 'high' },
        ]}
        disabled={codexCli}
        className={codexCli
          ? 'px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-100/50 dark:bg-white/[0.05] opacity-50 cursor-not-allowed text-xs transition-all duration-200 shadow-sm'
          : selectClass}
      />
      <ButtonTooltip
        visible={codexCli && qualityHintVisible}
        text="Codex CLI 不支持质量参数"
      />
    </label>
  )

  const formatField = (
    <label className="flex flex-col gap-0.5">
      <span className={labelClass}>格式</span>
      <Select
        value={params.output_format}
        onChange={(val) => setParams({ output_format: val as any })}
        options={[
          { label: 'PNG', value: 'png' },
          { label: 'JPEG', value: 'jpeg' },
          { label: 'WebP', value: 'webp' },
        ]}
        className={selectClass}
      />
    </label>
  )

  const compressionField = (
    <label
      className="relative flex flex-col gap-0.5"
      onMouseEnter={showCompressionHint}
      onMouseLeave={hideCompressionHint}
      onTouchStart={startCompressionHintTouch}
      onTouchEnd={clearCompressionHintTimer}
      onTouchCancel={hideCompressionHint}
      onClick={showCompressionHint}
    >
      <span className={labelClass}>压缩率</span>
      <input
        value={outputCompressionInput}
        onChange={(e) => setOutputCompressionInput(e.target.value)}
        onBlur={commitOutputCompression}
        disabled={params.output_format === 'png'}
        type="number"
        min={0}
        max={100}
        placeholder="0-100"
        className={`px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] focus:outline-none text-xs transition-all duration-200 shadow-sm ${
          params.output_format === 'png'
            ? 'bg-gray-100/50 dark:bg-white/[0.05] opacity-50 cursor-not-allowed'
            : 'bg-white/50 dark:bg-white/[0.03]'
          }`}
      />
      <ButtonTooltip
        visible={compressionHintVisible}
        text="仅 JPEG 和 WebP 支持压缩率"
      />
    </label>
  )

  const moderationField = (
    <label
      className="relative flex flex-col gap-0.5"
      onMouseEnter={showModerationHint}
      onMouseLeave={hideModerationHint}
      onTouchStart={startModerationHintTouch}
      onTouchEnd={clearModerationHintTimer}
      onTouchCancel={hideModerationHint}
      onClick={showModerationHint}
    >
      <span className={labelClass}>审核</span>
      <Select
        value={settings.apiMode === 'responses' ? 'auto' : params.moderation}
        onChange={(val) => {
          if (settings.apiMode !== 'responses') setParams({ moderation: val as any })
        }}
        options={[
          { label: 'auto', value: 'auto' },
          { label: 'low', value: 'low' },
        ]}
        disabled={settings.apiMode === 'responses'}
        className={settings.apiMode === 'responses'
          ? 'px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-gray-100/50 dark:bg-white/[0.05] opacity-50 cursor-not-allowed text-xs transition-all duration-200 shadow-sm'
          : selectClass}
      />
      <ButtonTooltip
        visible={settings.apiMode === 'responses' && moderationHintVisible}
        text="Responses API 不支持审核参数"
      />
    </label>
  )

  const countField = (
    <label className="flex flex-col gap-0.5">
      <span className={labelClass}>数量</span>
      <input
        value={nInput}
        onChange={(e) => setNInput(e.target.value)}
        onBlur={commitN}
        type="number"
        min={1}
        max={4}
        className="px-3 py-1.5 rounded-xl border border-gray-200/60 dark:border-white/[0.08] bg-white/50 dark:bg-white/[0.03] focus:outline-none text-xs transition-all duration-200 shadow-sm"
      />
    </label>
  )

  if (variant === 'mobile') {
    return (
      <div className="grid grid-cols-2 gap-2 text-xs flex-1">
        {channelField}
        {modelField}
        {sizeField}
        {qualityField}
        {formatField}
        {compressionField}
        {moderationField}
        {countField}
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2 text-xs lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1.45fr)_minmax(140px,1fr)_minmax(96px,0.7fr)]">
        {channelField}
        {modelField}
        {sizeField}
        {countField}
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs xl:grid-cols-4">
        {qualityField}
        {formatField}
        {compressionField}
        {moderationField}
      </div>
    </>
  )
}
