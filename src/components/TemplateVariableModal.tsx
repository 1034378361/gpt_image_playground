import { useEffect, useMemo, useState } from 'react'
import { applyTemplateWithVariables, useStore } from '../store'
import { extractTemplateVariables } from '../lib/templateUtils'
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
    () => template ? extractTemplateVariables(template.prompt, template.negativePrompt) : [],
    [template],
  )
  const [values, setValues] = useState<Record<string, string>>({})

  useCloseOnEscape(Boolean(template), () => setTemplateVariableTemplateId(null))

  useEffect(() => {
    setValues(Object.fromEntries(variables.map((name) => [name, ''])))
  }, [variables])

  if (!template) return null

  const canApply = variables.every((name) => values[name]?.trim())

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

        <div className="space-y-3">
          {variables.map((name) => (
            <label key={name} className="block">
              <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">{name}</span>
              <input
                value={values[name] ?? ''}
                onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
                className="w-full rounded-xl border border-gray-200/70 bg-white/60 px-3 py-2 text-sm text-gray-700 outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-gray-200 dark:focus:border-blue-500/50"
                autoFocus={variables[0] === name}
              />
            </label>
          ))}
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
