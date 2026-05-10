import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-950 p-6">
        <div className="max-w-md w-full rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-500/20 dark:bg-gray-900">
          <h2 className="text-lg font-semibold text-red-600 dark:text-red-400">页面出错了</h2>
          <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
            应用遇到了意外错误。刷新页面通常可以恢复正常。
          </p>
          {this.state.error && (
            <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-gray-100 p-3 text-xs text-gray-700 dark:bg-white/[0.04] dark:text-gray-300">
              {this.state.error.message}
            </pre>
          )}
          <button
            onClick={() => window.location.reload()}
            className="mt-4 w-full rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600"
          >
            刷新页面
          </button>
        </div>
      </div>
    )
  }
}
