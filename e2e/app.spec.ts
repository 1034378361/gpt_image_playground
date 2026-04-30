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
    recommendedChannelId: publicChannel.id,
    recommendedApiMode: 'images',
    recommendedModel: 'gpt-image-2',
    linkedTaskIds: [],
    isFavorite: false,
    sourceName: '',
    sourceUrl: '',
    sourceAuthor: '',
    licenseName: '',
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

    if (path === '/templates') {
      await fulfillJson(route, 200, templates)
      return
    }

    if (path === '/generations') {
      await fulfillJson(route, 200, tasks)
      return
    }

    if (path === '/admin/channels') {
      await fulfillJson(route, 200, sessionUser?.role === 'admin' ? [adminChannel] : [])
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
  await expect(page.getByText('渠道效果榜')).toBeVisible()
  await expect(page.locator('[title="管理员设置"]')).toBeVisible()

  await page.locator('[title="管理员设置"]').click()
  await expect(page.getByText('管理员设置')).toBeVisible()
})

test('hides admin settings for normal users and supports task/template switching', async ({ page }) => {
  await mockApp(page, { initialUser: normalUser })

  await page.goto('/')

  await expect(page.getByText('渠道效果榜')).toBeVisible()
  await expect(page.locator('[title="管理员设置"]')).toHaveCount(0)
  await expect(page.getByPlaceholder('搜索提示词、参数...')).toBeVisible()
  await expect(page.getByText('A studio bottle render')).toBeVisible()

  await page.locator('header').getByRole('button', { name: '模板', exact: true }).click()
  await expect(page.getByPlaceholder('搜索模板标题、提示词、标签...')).toBeVisible()
  await expect(page.getByText('电商产品白底')).toBeVisible()

  await page.locator('header').getByRole('button', { name: '任务', exact: true }).click()
  await expect(page.getByPlaceholder('搜索提示词、参数...')).toBeVisible()
})
