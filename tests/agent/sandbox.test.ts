import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import {
  AgentSandboxRunner,
  SandboxPolicyCompiler,
} from '../../packages/core/src/agent/execution/sandbox'
import { processTool } from '../../packages/core/src/core/karin/tool'
import { defaultConfig } from '../../packages/core/src/utils/config/default'

import type { AgentConfig } from '../../packages/core/src/types/agent'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(item => fs.rm(item, { recursive: true, force: true })))
})

const fixture = async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-sandbox-test-'))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'karin-sandbox-outside-'))
  directories.push(root, outside)
  const config = structuredClone(defaultConfig.agent) as AgentConfig
  config.execution.sandbox.readRoots = [root]
  config.execution.sandbox.writeRoots = [root]
  return { root, outside, config }
}

describe('Agent SandboxRunner', () => {
  it('rejects cwd and requested roots outside administrator roots', async () => {
    const { root, outside, config } = await fixture()
    const compiler = new SandboxPolicyCompiler(() => config)
    await expect(compiler.compile(outside)).rejects.toThrow(/cwd 越界/)
    await expect(compiler.compile(root, { readRoots: [outside] }))
      .rejects.toThrow(/超出管理员允许范围/)
  })

  it.skipIf(process.platform === 'win32')(
    'rejects a requested root that escapes through a symbolic link',
    async () => {
      const { root, outside, config } = await fixture()
      const link = path.join(root, 'outside-link')
      await fs.symlink(outside, link, 'dir')
      const compiler = new SandboxPolicyCompiler(() => config)
      await expect(compiler.compile(root, { readRoots: [link] }))
        .rejects.toThrow(/超出管理员允许范围/)
    }
  )

  it('defaults to deny network and never reports an unverified backend as hard isolation', async () => {
    const { root, config } = await fixture()
    const runner = new AgentSandboxRunner(() => config)
    const initial = runner.status()
    expect(initial.network).toBe('deny')
    expect(initial.hardIsolation).toBe(false)
    const launch = await runner.prepare({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("ok")'],
      cwd: root,
      env: { PATH: process.env.PATH || '' } as unknown as NodeJS.ProcessEnv,
    })
    expect(launch.execution.network).toBe('inherit')
    expect(launch.execution.hardIsolation).toBe(false)
    expect(launch.execution.reason).toMatch(/未执行网络隔离|doctor/)
  })

  it('fails closed when os isolation is required and doctor has not passed', async () => {
    const { root, config } = await fixture()
    config.execution.minimumIsolation = 'os'
    const runner = new AgentSandboxRunner(() => config)
    await expect(runner.prepare({ command: process.execPath, cwd: root }))
      .rejects.toThrow(/操作系统级隔离|doctor/)
  })

  it('does not pass undeclared environment variables to a process tool', async () => {
    const key = 'KARIN_SANDBOX_UNDECLARED_TEST'
    const previous = process.env[key]
    process.env[key] = 'must-not-leak'
    try {
      const isolated = processTool({
        name: 'sandbox.environment_test',
        description: 'Return an undeclared environment variable',
        inputSchema: { type: 'object', additionalProperties: false },
        process: {
          command: process.execPath,
          args: ['-e', `process.stdout.write(JSON.stringify(process.env.${key} ?? null))`],
        },
      })
      const result = await isolated.execute({}, {
        threadId: 'sandbox-thread',
        turnId: 'sandbox-turn',
        actor: {
          id: 'sandbox-user',
          role: 'all',
          selfId: 'bot',
          scene: 'friend',
          contactKey: 'friend:sandbox-user',
        },
        signal: new AbortController().signal,
        automated: false,
      })
      expect(result).toBeNull()
    } finally {
      if (previous === undefined) delete process.env[key]
      else process.env[key] = previous
    }
  })

  it.runIf(
    process.env.KARIN_SANDBOX_INTEGRATION === '1' && process.platform !== 'win32'
  )('passes the native backend self-test on Unix CI', async () => {
    const config = structuredClone(defaultConfig.agent) as AgentConfig
    const status = await new AgentSandboxRunner(() => config).doctor()
    expect(status.lastDoctor?.checks).toMatchObject({
      allowedWrite: true,
      outsideWriteDenied: true,
      networkDenied: true,
      processTreeTerminated: true,
    })
    expect(status.hardIsolation).toBe(true)
  })

  it.runIf(
    process.env.KARIN_SANDBOX_INTEGRATION === '1' && process.platform === 'win32'
  )('does not misreport the compatibility Windows helper as hard isolation', async () => {
    const config = structuredClone(defaultConfig.agent) as AgentConfig
    const status = await new AgentSandboxRunner(() => config).doctor()
    expect(status.hardIsolation).toBe(false)
  })
})
