import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const rootDir = process.cwd()
const packageJson = readJson('package.json')
const packageLock = readJson('package-lock.json')
const packageVersion = packageJson.version
const lockVersion = packageLock.version
const lockRootVersion = packageLock.packages?.['']?.version
const tagVersion = normalizeTagVersion(process.argv[2] || process.env.GITHUB_REF_NAME || process.env.GITHUB_REF || '')

if (!packageVersion) {
  fail('package.json is missing a version field')
}

assertEqual('package-lock.json version', lockVersion, packageVersion)
assertEqual('package-lock root package version', lockRootVersion, packageVersion)

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

function assertEqual(label, actual, expected) {
  if (actual !== expected) {
    fail(`${label} (${actual ?? 'missing'}) does not match package.json version (${expected})`)
  }
}

function fail(message) {
  console.error(`Version check failed: ${message}`)
  process.exit(1)
}
