import { Suspense, lazy, useEffect } from 'react'
import { useStore } from './store'
import { initStore, syncServerData } from './storeBackend'
import AuthScreen from './components/AuthScreen'
import Header from './components/Header'
import SearchBar from './components/SearchBar'
import Toast from './components/Toast'

const TaskGrid = lazy(() => import('./components/TaskGrid'))
const TemplateFilterBar = lazy(() => import('./components/TemplateFilterBar'))
const TemplateGrid = lazy(() => import('./components/TemplateGrid'))
const ProjectBoardBar = lazy(() => import('./components/ProjectBoardBar'))
const InputBar = lazy(() => import('./components/InputBar'))
const DetailModal = lazy(() => import('./components/DetailModal'))
const TemplateDetailModal = lazy(() => import('./components/TemplateDetailModal'))
const TemplateEditorModal = lazy(() => import('./components/TemplateEditorModal'))
const ProjectManagerModal = lazy(() => import('./components/ProjectManagerModal'))
const Lightbox = lazy(() => import('./components/Lightbox'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))
const ConfirmDialog = lazy(() => import('./components/ConfirmDialog'))
const MaskEditorModal = lazy(() => import('./components/MaskEditorModal'))
const ImageContextMenu = lazy(() => import('./components/ImageContextMenu'))
const TemplateVariableModal = lazy(() => import('./components/TemplateVariableModal'))

function OverlayFallback() {
  return null
}

function ViewFallback() {
  return (
    <div className="px-6 py-10">
      <div className="rounded-3xl border border-gray-200 bg-white px-6 py-5 text-sm text-gray-500 shadow-sm dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-400">
        正在加载页面内容...
      </div>
    </div>
  )
}

export default function App() {
  const currentView = useStore((s) => s.currentView)
  const backendReady = useStore((s) => s.backendReady)
  const backendUser = useStore((s) => s.backendUser)
  const backendUnavailableReason = useStore((s) => s.backendUnavailableReason)

  useEffect(() => {
    void initStore()
  }, [])

  useEffect(() => {
    const preventPageImageDrag = (e: DragEvent) => {
      if ((e.target as HTMLElement | null)?.closest('img')) {
        e.preventDefault()
      }
    }

    document.addEventListener('dragstart', preventPageImageDrag)
    return () => document.removeEventListener('dragstart', preventPageImageDrag)
  }, [])

  useEffect(() => {
    if (!backendUser) return

    let syncing = false
    const refresh = () => {
      if (syncing || document.visibilityState !== 'visible') return
      syncing = true
      void syncServerData().finally(() => {
        syncing = false
      })
    }

    const handleFocus = () => refresh()
    const handleVisibilityChange = () => refresh()
    const intervalId = window.setInterval(refresh, 60_000)

    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [backendUser])

  if (!backendReady) {
    return (
      <>
        <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
          <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6 py-10">
            <div className="rounded-3xl border border-gray-200 bg-white px-8 py-6 text-sm text-gray-600 shadow-sm dark:border-white/[0.08] dark:bg-gray-900 dark:text-gray-300">
              正在连接后端...
            </div>
          </div>
        </div>
        <Toast />
      </>
    )
  }

  if (!backendUser) {
    if (backendUnavailableReason) {
      return (
        <>
          <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
            <div className="mx-auto flex min-h-screen max-w-3xl items-center justify-center px-6 py-10">
              <div className="w-full rounded-3xl border border-amber-200 bg-white px-8 py-7 shadow-sm dark:border-amber-400/20 dark:bg-gray-900">
                <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">当前部署缺少后端</h1>
                <p className="mt-3 text-sm leading-6 text-gray-600 dark:text-gray-300">{backendUnavailableReason}</p>
                <p className="mt-3 text-sm leading-6 text-gray-500 dark:text-gray-400">
                  这个版本已经改为后端统一登录、统一渠道配置和统一模板管理，不能再单独作为纯静态页面使用。
                </p>
              </div>
            </div>
          </div>
          <Toast />
        </>
      )
    }
    return (
      <>
        <AuthScreen />
        <Toast />
      </>
    )
  }

  return (
    <>
      <Header />
      <main data-home-main className="safe-area-x max-w-7xl mx-auto pb-48">
        <Suspense fallback={<ViewFallback />}>
          <ProjectBoardBar />
          {currentView === 'templates' ? (
            <>
              <TemplateFilterBar />
              <TemplateGrid />
            </>
          ) : (
            <>
              <SearchBar />
              <TaskGrid />
            </>
          )}
        </Suspense>
      </main>
      <Suspense fallback={<OverlayFallback />}>
        <InputBar />
        <DetailModal />
        <TemplateDetailModal />
        <TemplateEditorModal />
        <ProjectManagerModal />
        <Lightbox />
        <SettingsModal />
        <ConfirmDialog />
      </Suspense>
      <Toast />
      <Suspense fallback={<OverlayFallback />}>
        <MaskEditorModal />
        <ImageContextMenu />
        <TemplateVariableModal />
      </Suspense>
    </>
  )
}
