import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import './index.css'
import { installMobileViewportGuards } from './lib/viewport'

installMobileViewportGuards()

const LEGACY_BROWSER_CACHE_CLEANUP_KEY = 'gip:legacy-browser-cache-cleanup:v1'

async function clearLegacyBrowserCachesOnce() {
  try {
    if (localStorage.getItem(LEGACY_BROWSER_CACHE_CLEANUP_KEY) === 'done') return
  } catch {
    return
  }

  const cleanupTasks: Promise<unknown>[] = []
  if ('serviceWorker' in navigator) {
    cleanupTasks.push(
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister()))),
    )
  }
  if ('caches' in window) {
    cleanupTasks.push(caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key)))))
  }

  await Promise.allSettled(cleanupTasks)
  try {
    localStorage.setItem(LEGACY_BROWSER_CACHE_CLEANUP_KEY, 'done')
  } catch {
    /* ignore */
  }
}

void clearLegacyBrowserCachesOnce()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
