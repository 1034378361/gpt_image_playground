import { useEffect, useMemo, useState } from 'react'
import { applyTemplateWithVariables, useStore } from '../store'
import {
  composeTemplatePrompt,
  extractTemplateVariableDefinitions,
  formFieldsToVariableDefinitions,
  type TemplateVariableDefinition,
} from '../lib/templateUtils'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

export default function TemplateVariableModal() {
  const templates = useStore((s) => s.templates)
  const templateId = useStore((s) => s.templateVariableTemplateId)
  const setTemplateVariableTemplateId = useStore((s) => s.setTemplateVariableTemplateId)
  const template = useMemo(
    () => templates.find((item) => item.id === templateId) ?? null,
    [templateId, templates],
  )
  const variables = useMemo(
    () =>
      template
        ? template.formFields.length
          ? formFieldsToVariableDefinitions(template.formFields)
          : extractTemplateVariableDefinitions(template.prompt, template.negativePrompt)
        : [],
    [template],
  )
  const [values, setValues] = useState<Record<string, string>>({})

  useCloseOnEscape(Boolean(template), () => setTemplateVariableTemplateId(null))

  useEffect(() => {
    setValues(Object.fromEntries(variables.map((item) => [item.name, item.defaultValue])))
  }, [variables])

  if (!template) return null

  const canApply = variables.every((item) => !item.required || item.defaultValue || values[item.name]?.trim())
  const finalPrompt = composeTemplatePrompt(template, values)
  const sourceLabel = (source: string) => {
    if (source === 'form') return '表单'
    if (source === 'argument') return '参数'
    if (source === 'placeholder') return '占位符'
    return '变量'
  }
  const typeLabel = (type: TemplateVariableDefinition['type']) => {
    if (type === 'textarea') return '长文本'
    if (type === 'select') return '选项'
    if (type === 'color') return '颜色'
    if (type === 'number') return '数值'
    if (type === 'image') return '图片'
    return '文本'
  }
  const updateValue = (name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }))
  }
  const renderControl = (item: TemplateVariableDefinition, autoFocus: boolean) => {
    const value = values[item.name] ?? ''
    const placeholder = item.example || item.defaultValue || item.name
    const baseClass = 'w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50'

    if (item.type === 'select' && item.options.length) {
      return (
        <select
          value={value}
          onChange={(event) => updateValue(item.name, event.target.value)}
          className={baseClass}
          autoFocus={autoFocus}
        >
          <option value="">{item.required ? '请选择' : '不指定'}</option>
          {item.options.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      )
    }

    if (item.type === 'color') {
      const colorValue = /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'
      return (
        <div className="flex gap-2">
          <input
            type="color"
            value={colorValue}
            onChange={(event) => updateValue(item.name, event.target.value)}
            className="h-10 w-12 flex-shrink-0 rounded-xl border border-gray-200/70 bg-white p-1 dark:border-white/[0.08] dark:bg-white/[0.03]"
            autoFocus={autoFocus}
            aria-label={`${item.name} 颜色`}
          />
          <input
            value={value}
            onChange={(event) => updateValue(item.name, event.target.value)}
            placeholder={placeholder || '#000000'}
            className={baseClass}
          />
        </div>
      )
    }

    if (item.type === 'textarea' || (item.defaultValue || item.name).length > 42) {
      return (
        <textarea
          value={value}
          onChange={(event) => updateValue(item.name, event.target.value)}
          placeholder={placeholder}
          rows={3}
          className={`${baseClass} resize-y`}
          autoFocus={autoFocus}
        />
      )
    }

    return (
      <input
        type={item.type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(event) => updateValue(item.name, event.target.value)}
        placeholder={item.type === 'image' ? placeholder || '图片 URL、素材编号或图片描述' : placeholder}
        className={baseClass}
        autoFocus={autoFocus}
      />
    )
  }

  return (
    <div
      data-no-drag-select
      className="fixed inset-0 z-[95] flex items-center justify-center p-4"
      onClick={() => setTemplateVariableTemplateId(null)}
    >
      <div className="absolute inset-0 bg-black/20 dark:bg-black/40 backdrop-blur-md animate-overlay-in" />
      <div
        className="relative z-10 w-full max-w-md rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between gap-4">
          <h3 className="min-w-0 truncate text-base font-semibold text-gray-800 dark:text-gray-100">
            填写模板变量
          </h3>
          <button
            onClick={() => setTemplateVariableTemplateId(null)}
            className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
            aria-label="关闭"
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18 18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <p className="mb-4 truncate text-sm text-gray-500 dark:text-gray-400" title={template.title}>
          {template.title}
        </p>

        <div className="max-h-[55vh] space-y-3 overflow-y-auto pr-1">
          {variables.map((item, index) => (
            <label key={item.name} className="block">
              <span className="mb-1 flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400">
                <span className="min-w-0 truncate">
                  {item.name}
                  {item.required && <span className="ml-1 text-red-400">*</span>}
                </span>
                <span className="flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
                  {sourceLabel(item.source)} · {typeLabel(item.type)}
                </span>
                {item.defaultValue && (
                  <span className="truncate text-gray-400 dark:text-gray-500">默认: {item.defaultValue}</span>
                )}
              </span>
              {item.description && (
                <span className="mb-1 block text-xs leading-5 text-gray-400 dark:text-gray-500">{item.description}</span>
              )}
              {renderControl(item, index === 0)}
              {item.example && (
                <span className="mt-1 block truncate text-xs text-gray-400 dark:text-gray-500">示例: {item.example}</span>
              )}
            </label>
          ))}
        </div>

        <div className="mt-4 rounded-xl border border-gray-200/70 bg-gray-50/80 px-3 py-2 text-xs text-gray-500 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-400">
          <div className="mb-1 font-medium text-gray-600 dark:text-gray-300">最终提示词预览</div>
          <p className="max-h-28 overflow-y-auto whitespace-pre-wrap break-words leading-5">
            {finalPrompt || '(等待填写变量)'}
          </p>
        </div>

        <div className="mt-5 flex gap-2 border-t border-gray-100 pt-4 dark:border-white/[0.08]">
          <button
            onClick={() => setTemplateVariableTemplateId(null)}
            className="flex-1 rounded-xl border border-gray-200 px-4 py-2 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-white/[0.08] dark:text-gray-300 dark:hover:bg-white/[0.06]"
          >
            取消
          </button>
          <button
            onClick={() => applyTemplateWithVariables(template, values)}
            disabled={!canApply}
            className="flex-1 rounded-xl bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            套用模板
          </button>
        </div>
      </div>
    </div>
  )
}
