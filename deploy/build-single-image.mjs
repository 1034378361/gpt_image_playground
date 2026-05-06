import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const rootDir = process.cwd()
const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
const imageName = process.env.GIP_IMAGE_NAME || pkg.name || 'gpt-image-playground'
const version = process.env.GIP_IMAGE_TAG || pkg.version
const saveImage = process.argv.includes('--save')

const gitShort = runAndRead('git', ['rev-parse', '--short', 'HEAD']) || 'unknown'
const gitFull = runAndRead('git', ['rev-parse', 'HEAD']) || 'unknown'
const buildDate = new Date().toISOString()
const versionTag = sanitizeTag(version)
const shaTag = sanitizeTag(`sha-${gitShort}`)
const latestTag = 'latest'

const tags = [versionTag, shaTag, latestTag]
const buildArgs = [
  '--build-arg', `APP_VERSION=${versionTag}`,
  '--build-arg', `VCS_REF=${gitFull}`,
  '--build-arg', `BUILD_DATE=${buildDate}`,
]
const tagArgs = tags.flatMap((tag) => ['-t', `${imageName}:${tag}`])

run('docker', ['build', '-f', 'deploy/Dockerfile.all-in-one', ...buildArgs, ...tagArgs, '.'])

const metadata = {
  imageName,
  version: versionTag,
  gitShort,
  gitFull,
  buildDate,
  tags: tags.map((tag) => `${imageName}:${tag}`),
}

writeFileSync(join(rootDir, 'deploy', 'single-image-build.json'), `${JSON.stringify(metadata, null, 2)}\n`)

if (saveImage) {
  const tarName = `${imageName}-${versionTag}.tar`
  run('docker', ['save', '-o', tarName, `${imageName}:${versionTag}`])
  console.log(`Saved ${tarName}`)
}

console.log(JSON.stringify(metadata, null, 2))

function sanitizeTag(value) {
  return String(value || 'latest')
    .trim()
    .replace(/[^A-Za-z0-9_.-]/g, '-')
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: rootDir, stdio: 'inherit' })
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function runAndRead(command, args) {
  const result = spawnSync(command, args, { cwd: rootDir, encoding: 'utf8' })
  if (result.status !== 0) return ''
  return result.stdout.trim()
}
