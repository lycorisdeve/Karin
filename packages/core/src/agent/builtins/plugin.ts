import { spawn } from 'node:child_process'

const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
const packageVersion = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

export const updateNpmPlugin = (name: string, version = 'latest', signal?: AbortSignal) => {
  if (!packageName.test(name)) throw new Error('npm 包名非法')
  if (!packageVersion.test(version)) throw new Error('npm 版本非法')

  const executable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(executable, ['update', `${name}@${version}`, '--save'], {
      cwd: process.cwd(),
      shell: false,
      signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const append = (data: Buffer) => {
      output = `${output}${data.toString()}`.slice(-65536)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolve({ code, output })
      else reject(new Error(`插件更新失败，退出码 ${code}\n${output}`))
    })
  })
}
