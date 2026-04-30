import { useState } from 'react'
import { useStore } from '../store'
import { loginBackend, registerBackend } from '../storeBackend'

export default function AuthScreen() {
  const showToast = useStore((s) => s.showToast)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState<'login' | 'register' | null>(null)

  const validate = () => {
    const normalizedUsername = username.trim()
    if (!normalizedUsername) {
      showToast('请输入用户名', 'error')
      return null
    }
    if (normalizedUsername.length < 3) {
      showToast('用户名至少需要 3 位', 'error')
      return null
    }
    if (!password) {
      showToast('请输入密码', 'error')
      return null
    }
    if (password.length < 8) {
      showToast('密码至少需要 8 位', 'error')
      return null
    }
    return { username: normalizedUsername, password }
  }

  const run = async (mode: 'login' | 'register') => {
    const credentials = validate()
    if (!credentials) return
    setBusy(mode)
    try {
      if (mode === 'login') {
        await loginBackend(credentials.username, credentials.password)
      } else {
        await registerBackend(credentials.username, credentials.password)
      }
      setPassword('')
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-6 py-10">
        <div className="grid w-full gap-8 lg:grid-cols-[1.2fr,0.9fr]">
          <section className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm dark:border-white/[0.08] dark:bg-gray-900">
            <div className="max-w-xl">
              <p className="text-sm font-medium text-blue-600 dark:text-blue-300">后端统一访问</p>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">GPT Image Playground</h1>
              <p className="mt-4 text-sm leading-7 text-gray-600 dark:text-gray-300">
                现在所有模板、生成任务、渠道和模型配置都通过后端统一管理。登录后才能进入前端；普通用户只能使用管理员开放的渠道和模型。
              </p>
              <div className="mt-6 grid gap-3 text-sm text-gray-600 dark:text-gray-300">
                <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  私有模板归个人所有，可提交到公共模板库等待管理员审批。
                </div>
                <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  Base URL、API Key 和请求超时只允许管理员配置。
                </div>
                <div className="rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 dark:border-white/[0.08] dark:bg-white/[0.03]">
                  如果系统里还没有账号，首个注册用户会自动成为管理员。
                </div>
              </div>
            </div>
          </section>

          <section className="rounded-3xl border border-gray-200 bg-white p-8 shadow-sm dark:border-white/[0.08] dark:bg-gray-900">
            <h2 className="text-lg font-semibold">登录或注册</h2>
            <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">先完成账户登录，才能访问模板库和任务页。</p>
            <div className="mt-6 space-y-4">
              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">用户名</span>
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  type="text"
                  autoComplete="username"
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-gray-500 dark:text-gray-400">密码</span>
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  autoComplete="current-password"
                  className="w-full rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-300 dark:border-white/[0.08] dark:bg-white/[0.04] dark:text-gray-200 dark:focus:border-blue-500/50"
                />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => void run('login')}
                  disabled={busy !== null}
                  className="rounded-xl bg-blue-500 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-blue-600 disabled:cursor-wait disabled:opacity-50"
                >
                  {busy === 'login' ? '登录中...' : '登录'}
                </button>
                <button
                  type="button"
                  onClick={() => void run('register')}
                  disabled={busy !== null}
                  className="rounded-xl bg-gray-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-black disabled:cursor-wait disabled:opacity-50 dark:bg-white/[0.12] dark:hover:bg-white/[0.18]"
                >
                  {busy === 'register' ? '注册中...' : '注册'}
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
