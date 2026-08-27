import fs from 'node:fs'
import path from 'node:path'

const workspaceRoot = process.cwd()
const packagesRoot = path.join(workspaceRoot, 'packages')
const dependencyFields = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'devDependencies',
]

const workspaceVersions = new Map()

for (const entry of fs.readdirSync(packagesRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue

  const manifestPath = path.join(packagesRoot, entry.name, 'package.json')
  if (!fs.existsSync(manifestPath)) continue

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  if (manifest.name && manifest.version) {
    workspaceVersions.set(manifest.name, manifest.version)
  }
}

const targets = process.argv.slice(2)
if (targets.length === 0) {
  throw new Error('至少需要指定一个待发布的包目录')
}

for (const target of targets) {
  const manifestPath = path.resolve(workspaceRoot, target, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))

  for (const field of dependencyFields) {
    const dependencies = manifest[field]
    if (!dependencies) continue

    for (const [name, specifier] of Object.entries(dependencies)) {
      if (typeof specifier !== 'string' || !specifier.startsWith('workspace:')) continue

      const version = workspaceVersions.get(name)
      if (!version) {
        throw new Error(`${manifest.name}: 找不到工作区依赖 ${name} 的版本`)
      }

      const range = specifier.slice('workspace:'.length)
      if (range === '*') dependencies[name] = version
      else if (range === '^') dependencies[name] = `^${version}`
      else if (range === '~') dependencies[name] = `~${version}`
      else if (/^[~^]?\d/.test(range)) dependencies[name] = range
      else throw new Error(`${manifest.name}: 不支持的 workspace 协议 ${specifier}`)
    }
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Prepared ${manifest.name}@${manifest.version}`)
}
