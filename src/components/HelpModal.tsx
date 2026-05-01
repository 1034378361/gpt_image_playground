import { useState, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useCloseOnEscape } from '../hooks/useCloseOnEscape'

const CURRENT_REPO_URL = 'https://github.com/1034378361/gpt_image_playground'
const UPSTREAM_REPO_URL = 'https://github.com/CookSleep/gpt_image_playground'

const MOBILE_SECTIONS = [
  {
    title: '快速开始',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
    ),
    items: [
      '首次进入需要先登录；如果系统中还没有账号，第一个注册用户会自动成为管理员。',
      '普通用户只能使用管理员开放的渠道和模型，无法查看 Base URL、API Key 或全局超时配置。',
      '输入提示词后发起生成，任务会统一进入后端队列并由服务端执行。',
    ],
  },
  {
    title: '模板与项目',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h16v4H4zm0 6h16v10H4z" />
    ),
    items: [
      '模板支持私有使用、项目归属、封面设置和变量化复用。',
      '私有模板可以投稿到公共模板库，但需要管理员或审核员审批后才会公开。',
      '项目适合把模板、任务和风格实验围绕具体业务主题组织起来。',
    ],
  },
  {
    title: '移动端操作',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    ),
    items: [
      '历史记录卡片支持左右滑动选中或取消选中。',
      '选中后底部会出现批量操作栏，可进行收藏、删除和全选当前可见记录。',
      '长按图片可以复制、下载，或把结果图加入下一轮编辑。',
    ],
  },
]

const DESKTOP_SECTIONS = [
  {
    title: '快速开始',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
    ),
    items: [
      '首次进入需要先登录；如果系统中还没有账号，第一个注册用户会自动成为管理员。',
      '管理员负责配置渠道、模型、Base URL、API Key 和超时时间；普通用户只能选择管理员开放的渠道和模型。',
      '生成请求会统一走后端队列，渠道健康度和兼容性检测结果会影响推荐使用方式。',
    ],
  },
  {
    title: '模板与项目',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4h16v4H4zm0 6h16v10H4z" />
    ),
    items: [
      '模板支持私有草稿、项目归属、公共投稿、封面设置、变量化复用和版本恢复。',
      '公共模板需要管理员或审核员审批，审核通过后才会进入公共模板库。',
      '项目视角适合把模板、任务和风格实验按业务主题组织起来。',
    ],
  },
  {
    title: '历史与图片操作',
    icon: (
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    ),
    items: [
      '可用鼠标拖拽框选，或按住 Ctrl / Cmd 单独增删选择。',
      '批量操作栏支持收藏、删除和全选当前可见记录。',
      '右键图片可以复制、下载，或把结果图加入参考图继续迭代。',
    ],
  },
]

function renderSection(section: { title: string; icon: React.ReactNode; items: string[] }) {
  return (
    <section key={section.title}>
      <h4 className="mb-4 text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
        <svg className="w-4 h-4 text-gray-400 dark:text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          {section.icon}
        </svg>
        {section.title}
      </h4>
      <div className="space-y-4">
        <ul className="list-disc pl-4 space-y-2">
          {section.items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}

interface HelpModalProps {
  onClose: () => void
}

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(window.innerWidth < 640)
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 640)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return isMobile
}

export default function HelpModal({ onClose }: HelpModalProps) {
  const isMobile = useIsMobile()
  useCloseOnEscape(true, onClose)

  return createPortal(
    <div
      data-no-drag-select
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm animate-overlay-in" />
      <div
        className="relative z-10 w-full max-w-md rounded-3xl border border-white/50 bg-white/95 p-5 shadow-2xl ring-1 ring-black/5 animate-modal-in dark:border-white/[0.08] dark:bg-gray-900/95 dark:ring-white/10 flex flex-col max-h-[85vh] custom-scrollbar"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between gap-4">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <svg className="w-5 h-5 text-blue-500" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" />
              <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
              <path d="M12 17h.01" />
            </svg>
            操作指南
          </h3>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="rounded-full p-1 text-gray-400 transition hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-white/[0.06] dark:hover:text-gray-200"
              aria-label="关闭"
            >
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto mb-6 text-sm text-gray-600 dark:text-gray-300 space-y-6 custom-scrollbar pr-2">
          <section className="rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-200">
            当前为独立维护版 <span className="font-mono font-semibold">v{__APP_VERSION__}</span>。此版本已切换为后端统一登录、统一渠道配置、模板审核与项目化管理，不再沿用原始的前端直连模式。
          </section>
          {(isMobile ? MOBILE_SECTIONS : DESKTOP_SECTIONS).map(renderSection)}
        </div>

        <div className="pt-4 border-t border-gray-200 dark:border-white/[0.08] space-y-2 text-center">
          <p className="text-xs font-mono text-gray-400 dark:text-gray-500">Version v{__APP_VERSION__} · 1.x 独立版</p>
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm">
            <a
              href={CURRENT_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 font-medium text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 group"
            >
              <svg className="w-5 h-5 group-hover:scale-110 transition-transform" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              当前维护仓库
            </a>
            <a
              href={UPSTREAM_REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-gray-400 transition-colors hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-300"
            >
              上游来源：CookSleep
            </a>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}
