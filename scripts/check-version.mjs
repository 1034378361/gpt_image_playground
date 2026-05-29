import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const rootDir = process.cwd()
const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')
const packageVersion = packageJson.version
const lockVersion = packageLock.version
const lockRootVersion = packageLock.packages?.['']?.version
const tagVersion = normalizeTagVersion(process.argv[2] || process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || '')
const deployEnvVersionKeys = ['GIP_IMAGE_TAG', 'GIP_IMAGE_BUILD_VERSION']

if (!packageVersion) {
  fail('package.json is missing a version field')
}

assertEqual('package-lock.json version', lockVersion, packageVersion)
assertEqual('package-lock root package version', lockRootVersion, packageVersion)
assertDeployEnvVersions(packageVersion)

if (tagVersion) {
  assertEqual('release tag version', tagVersion, packageVersion)
}

console.log(`Version check passed: ${packageVersion}`)

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(rootDir, relativePath), 'utf8'))
}

function normalizeTagVersion(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const tag = raw.startsWith('refs/tags/') ? raw.slice('refs/tags/'.length) : raw
  if (!tag.startsWith('v')) return ''
  return tag.slice(1)
}

function assertDeployEnvVersions(expected) {
  const deployDir = join(rootDir, 'deploy')
  if (!existsSync(deployDir)) return
  for (const fileName of readdirSync(deployDir)) {
    if (!fileName.endsWith('.env.example')) continue
    assertEnvVersionsInFile(`deploy/${fileName}`, expected)
  }
}

function assertEnvVersionsInFile(relativePath, expected) {
  const lines = readFileSync(join(rootDir, relativePath), 'utf8').split(/\r?\n/)
  for (const key of deployEnvVersionKeys) {
    const line = lines.find((item) => item.startsWith(`${key}=`))
    if (!line) continue
    assertEqual(`${relativePath} ${key}`, line.slice(key.length + 1).trim(), expected)
  }
}

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label} (${actual ?? 'missing'}) does not match package.json version (${expected})`)
  }
}

function fail(message) {
  console.error(`Version check failed: ${message}`)
  process.exit(1)
}
