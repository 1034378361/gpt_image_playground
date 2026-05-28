import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const rootDir = process.cwd()
const distDir = join(rootDir, 'dist')
const assetsDir = join(distDir, 'assets')

if (!existsSync(distDir)) {
  fail('dist directory is missing; run npm run build first')
}

assertFile('index.html')
assertFile('manifest.webmanifest')
assertFile('pwa-icon.svg')

if (existsSync(join(distDir, 'sw.js'))) {
  fail('dist/sw.js exists even though Service Worker support is disabled')
}

const bundleFiles = walkFiles(assetsDir).filter((file) => /\.(js|html)$/.test(file))
if (bundleFiles.length === 0) {
  fail('dist/assets contains no JavaScript bundles')
}

const forbiddenPatterns = [
  /navigator\.serviceWorker\.register/,
  /serviceWorker\.register/,
  /sw\.js\?v=/,
  /register\([^)]*sw\.js/,
]

for (const file of bundleFiles) {
  const content = readFileSync(file, 'utf8')
  for (const pattern of forbiddenPatterns) {
    if (pattern.test(content)) {
      fail(`${relative(file)} contains active Service Worker registration`)
    }
  }
}

console.log('Dist smoke check passed')

function assertFile(relativePath) {
  const path = join(distDir, relativePath)
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`dist/${relativePath} is missing`)
  }
}

function walkFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walkFiles(path) : [path]
  })
}

function relative(path) {
  return path.slice(rootDir.length + 1).replaceAll('\\\\', '/')
}

function fail(message) {
  console.error(`Dist smoke check failed: ${message}`)
  process.exit(1)
}
