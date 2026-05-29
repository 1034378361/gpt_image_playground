import { expect, test, type Page, type Route } from '@playwright/test'

const now = 1_710_000_000_000

const params = {
  size: 'auto',
  quality: 'auto',
  output_format: 'png',
  output_compression: null,
  moderation: 'auto',
  n: 1,
}

const adminUser = {
  id: 'user-admin',
  username: 'alice',
  role: 'admin',
  createdAt: now,
  updatedAt: now,
} as const

const normalUser = {
  id: 'user-normal',
  username: 'bob',
  role: 'user',
  createdAt: now,
  updatedAt: now,
} as const

const publicChannel = {
  id: 'channel-1',
  name: '心梦渠道',
  models: [
    { id: 'gpt-image-2', label: 'GPT Image 2', apiMode: 'images', enabled: true },
    { id: 'gpt-5.5', label: 'GPT 5.5', apiMode: 'responses', enabled: true },
  ],
  timeoutSeconds: 45,
  codexCli: false,
  codexCliMode: 'auto',
  healthStatus: 'healthy',
  healthMessage: '最近一次生成请求成功',
  healthCheckedAt: now,
  healthLatencyMs: 120,
  compatibilityStatus: 'standard',
  compatibilityMessage: '标准 OpenAI 风格',
  compatibilityCheckedAt: now,
  isEnabled: true,
  createdAt: now,
  updatedAt: now,
}

const adminChannel = {
  ...publicChannel,
  baseUrl: 'https://example.test/v1',
  apiKeyPreview: 'sk-te...est',
}

const leaderboard = [
  {
    channelId: publicChannel.id,
    channelName: publicChannel.name,
    model: 'gpt-image-2',
    apiMode: 'images',
    totalCount: 12,
    successCount: 10,
    failureCount: 2,
    successRate: 10 / 12,
    averageElapsed: 4800,
    lastUsedAt: now,
    healthStatus: 'healthy',
    compatibilityStatus: 'standard',
  },
]

const projects = [
  {
    id: 'project-1',
    name: '测试项目',
    description: '',
    color: '#3b82f6',
    isArchived: false,
    taskCount: 0,
    templateCount: 0,
    createdAt: now,
    updatedAt: now,
  },
]

const queueStats = {
  workerCount: 2,
  queuedCount: 0,
  runningCount: 0,
  yourQueuedCount: 0,
  yourRunningCount: 0,
}

function pageResult<T>(items: T[]) {
  return {
    items,
    total: items.length,
    limit: 80,
    offset: 0,
    hasMore: false,
  }
}

function buildTemplate(userId: string) {
  return {
    id: 'template-1',
    userId,
    title: '电商产品白底',
    description: '适合商品主图',
    prompt: 'A premium bottle on a clean white background',
    negativePrompt: null,
    tags: ['product', 'studio'],
    category: 'commerce',
    params,
    channelId: publicChannel.id,
    apiMode: 'images',
    model: 'gpt-image-2',
    coverImageId: null,
    externalCoverUrl: null,
    exampleImages: [],
    cachedExternalCoverUrl: null,
    cachedExampleImages: [],
    recommendedChannelId: publicChannel.id,
    recommendedApiMode: 'images',
    recommendedModel: 'gpt-image-2',
    linkedTaskIds: [],
    isFavorite: false,
    sourceName: '',
    sourceUrl: '',
    sourceAuthor: '',
    licenseName: '',
    formFields: [],
    collections: [],
    isFeatured: false,
    visibility: 'public',
    submissionStatus: 'approved',
    submittedAt: null,
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
    favoriteCount: 3,
    usageCount: 8,
    successCount: 6,
    failureCount: 1,
    ratingCount: 2,
    averageRating: 4.5,
    lastUsedAt: now,
    qualityScore: 88,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
}

function buildTask(userId: string) {
  return {
    id: 'task-1',
    userId,
    templateId: null,
    templateVersionId: null,
    prompt: 'A studio bottle render',
    params,
    inputImageIds: [],
    maskTargetImageId: null,
    maskImageId: null,
    outputImages: [],
    actualParams: null,
    actualParamsByImage: null,
    revisedPromptByImage: null,
    status: 'done',
    error: null,
    createdAt: now,
    finishedAt: now + 2000,
    elapsed: 2000,
    isFavorite: false,
    channelId: publicChannel.id,
    apiMode: 'images',
    model: 'gpt-image-2',
  }
}

async function fulfillJson(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

async function mockApp(page: Page, options: { initialUser: typeof adminUser | typeof normalUser | null; authUser?: typeof adminUser | typeof normalUser }) {
  let sessionUser = options.initialUser
  const authUser = options.authUser ?? options.initialUser ?? adminUser
  const templates = [buildTemplate(authUser.id)]
  const tasks = [buildTask(authUser.id)]

  await page.route('https://api.github.com/**', async (route) => {
    await fulfillJson(route, 200, { tag_name: 'v0.2.15', html_url: 'https://example.test/releases/latest' })
  })

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace(/^\/api/, '')

    if (path === '/auth/me') {
      if (sessionUser) {
        await fulfillJson(route, 200, sessionUser)
      } else {
        await fulfillJson(route, 401, { detail: 'Not authenticated' })
      }
      return
    }

    if (path === '/auth/login' || path === '/auth/register') {
      sessionUser = authUser
      await fulfillJson(route, 200, sessionUser)
      return
    }

    if (path === '/auth/logout') {
      sessionUser = null
      await fulfillJson(route, 200, { ok: true })
      return
    }

    if (path === '/channels') {
      await fulfillJson(route, 200, [publicChannel])
      return
    }

    if (path === '/channels/leaderboard') {
      await fulfillJson(route, 200, leaderboard)
      return
    }

    if (path === '/projects') {
      await fulfillJson(route, 200, projects)
      return
    }

    if (path === '/templates') {
      await fulfillJson(route, 200, pageResult(templates))
      return
    }

    if (path === '/generations') {
      await fulfillJson(route, 200, pageResult(tasks))
      return
    }

    if (path === '/generations/queue-stats') {
      await fulfillJson(route, 200, queueStats)
      return
    }

    if (path === '/generations/preflight') {
      await fulfillJson(route, 200, {
        ok: true,
        predictedApiMode: 'images',
        codexCli: false,
        normalizedParams: params,
        diagnostics: [],
      })
      return
    }

    if (path === '/admin/channels') {
      await fulfillJson(route, 200, sessionUser?.role === 'admin' ? [adminChannel] : [])
      return
    }

    if (path === '/admin/users') {
      await fulfillJson(route, 200, sessionUser?.role === 'admin' ? [adminUser, normalUser] : [])
      return
    }

    if (path === '/admin/template-submissions') {
      await fulfillJson(route, 200, [])
      return
    }

    if (path === '/admin/audit-logs') {
      await fulfillJson(route, 200, [])
      return
    }

    if (path === '/admin/open-prompt-sources') {
      await fulfillJson(route, 200, [])
      return
    }

    if (path === '/admin/open-prompt-discoveries') {
      await fulfillJson(route, 200, [])
      return
    }

    if (path === '/admin/auto-import/settings') {
      await fulfillJson(route, 200, {
        enabled: false,
        runHour: 3,
        githubTokenPreview: '',
        searchQueries: [],
        trustedRepos: [],
        includeKnownSources: true,
        autoApproveTrusted: false,
        maxRepositories: 12,
        maxTemplatesPerRun: 80,
        minHotScore: 20,
        lastRunAt: null,
        nextRunAt: null,
        updatedAt: now,
      })
      return
    }

    if (path === '/admin/auto-import/runs') {
      await fulfillJson(route, 200, [])
      return
    }

    await fulfillJson(route, 404, { detail: `Unhandled mock path: ${path}` })
  })
}

test('shows auth gate, completes admin registration, and opens admin settings', async ({ page }) => {
  await mockApp(page, { initialUser: null, authUser: adminUser })

  await page.goto('/')

  await expect(page.getByText('登录或注册')).toBeVisible()
  await page.getByLabel('用户名').fill('alice')
  await page.getByLabel('密码').fill('password123')
  await page.getByRole('button', { name: '注册' }).click()

  await expect(page.getByText('alice')).toBeVisible()
  await expect(page.getByRole('button', { name: /渠道状态/ })).toBeVisible()
  await expect(page.locator('[title="管理控制台"]')).toBeVisible()

  await page.locator('[title="管理控制台"]').click()
  await expect(page.getByRole('heading', { name: '管理控制台' })).toBeVisible({ timeout: 10_000 })
})

test('hides admin settings for normal users and supports task/template switching', async ({ page }) => {
  await mockApp(page, { initialUser: normalUser })

  await page.goto('/')

  await expect(page.getByRole('button', { name: /渠道状态/ })).toBeVisible()
  await expect(page.locator('[title="管理控制台"]')).toHaveCount(0)
  await expect(page.getByText('A studio bottle render')).toBeVisible()

  await page.locator('header').getByRole('button', { name: '模板', exact: true }).click()
  await expect(page.getByPlaceholder('搜索模板标题、提示词、标签...')).toBeVisible()
  await expect(page.getByText('电商产品白底')).toBeVisible()

  await page.locator('header').getByRole('button', { name: '任务', exact: true }).click()
  await expect(page.getByText('A studio bottle render')).toBeVisible()
})

test('keeps composer open while entering Chinese prompt and choosing channel or model', async ({ page }) => {
  await mockApp(page, { initialUser: normalUser })
  await page.goto('/')

  // The desktop composer is collapsed (translated off-screen) by default;
  // reveal it via the dedicated reveal button before interacting with the textarea.
  await page.getByRole('button', { name: '展开提示词输入区' }).click()

  const promptInput = page.getByPlaceholder('描述你想生成的图片...')
  await promptInput.focus()
  await expect(promptInput).toBeFocused()

  // Simulate a real IME composition session so onCompositionStart/End fire.
  await promptInput.evaluate((el) => {
    const target = el as HTMLTextAreaElement
    target.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }))
    target.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'zhongwen' }))
  })

  // While still composing, leaving the dock must NOT collapse the composer.
  await page.locator('[data-composer-dock]').dispatchEvent('mouseleave')
  await expect(promptInput).toBeFocused()

  await promptInput.evaluate((el) => {
    const target = el as HTMLTextAreaElement
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
    setter?.call(target, '中文提示词：一只玻璃杯放在木桌上，柔和自然光')
    target.dispatchEvent(new Event('input', { bubbles: true }))
    target.dispatchEvent(new CompositionEvent('compositionend', { data: target.value }))
  })

  await expect(page.getByText('最终提示词预览')).toBeVisible()

  await page.getByRole('button', { name: /渠道：心梦渠道/ }).click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.getByRole('option', { name: /心梦渠道/ }).click()
  await expect(promptInput).toBeVisible()
  await expect(page.getByText('最终提示词预览')).toBeVisible()

  await page.getByRole('button', { name: /模型：GPT Image 2/ }).click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.getByRole('option', { name: /GPT 5.5/ }).click()
  await expect(promptInput).toBeVisible()
  await expect(page.getByText('最终提示词预览')).toBeVisible()
})
