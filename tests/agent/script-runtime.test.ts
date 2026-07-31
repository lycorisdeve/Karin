import fs from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { karinPathTemp } from '@/root'
import {
  AgentPythonRuntime,
  normalizeScriptTool,
} from '@/agent/scripts/runtime'

import type {
  AgentConfig,
  AgentScriptToolDefinition,
} from '@/types/agent'

const runtimeConfig: AgentConfig['scriptRuntime'] = {
  pythonExecutable: '',
  defaultTimeoutMs: 30000,
  maxTimeoutMs: 120000,
  defaultMaxOutputBytes: 65536,
  maxOutputBytes: 1048576,
}

const definition = (
  patch: Partial<AgentScriptToolDefinition> = {}
): AgentScriptToolDefinition => ({
  id: 'normalize_data',
  name: 'Normalize data',
  description: 'Normalize a numeric value',
  runtime: 'python',
  source: 'def run(payload):\n    return {"value": payload["value"] * 2}\n',
  sourceHash: '',
  inputSchema: {
    type: 'object',
    required: ['value'],
    additionalProperties: false,
    properties: { value: { type: 'number' } },
  },
  outputSchema: {
    type: 'object',
    required: ['value'],
    additionalProperties: false,
    properties: { value: { type: 'number' } },
  },
  semantics: {
    objective: 'Double the supplied number',
    inputs: 'An object containing a numeric value',
    outputs: 'An object containing the doubled value',
    sideEffects: [],
    idempotent: true,
  },
  stop: {
    completionCondition: 'run returns a JSON serializable object',
    timeoutMs: 30000,
    maxOutputBytes: 65536,
  },
  failure: {
    strategy: 'fail',
    maxAttempts: 1,
    retryDelayMs: 0,
    userMessage: 'Normalization failed',
  },
  ...patch,
})

const runtime = (config = runtimeConfig) =>
  new AgentPythonRuntime(() => ({ scriptRuntime: config } as AgentConfig))

describe('managed Python Script Tool runtime', () => {
  it('requires business semantics, stop conditions and failure policy', () => {
    expect(() => normalizeScriptTool(
      definition({ semantics: undefined as never }),
      runtimeConfig
    )).toThrow('缺少业务语义')
    expect(() => normalizeScriptTool(
      definition({ stop: undefined as never }),
      runtimeConfig
    )).toThrow('缺少停止条件')
    expect(() => normalizeScriptTool(
      definition({ failure: undefined as never }),
      runtimeConfig
    )).toThrow('缺少失败策略')
  })

  it('rejects undeclared side effects and retry for non-idempotent scripts', () => {
    expect(() => normalizeScriptTool(definition({
      semantics: {
        ...definition().semantics,
        sideEffects: ['network'],
      },
    }), runtimeConfig)).toThrow('只允许无外部副作用')
    expect(() => normalizeScriptTool(definition({
      semantics: {
        ...definition().semantics,
        idempotent: false,
      },
      failure: {
        strategy: 'retry',
        maxAttempts: 2,
        retryDelayMs: 0,
        userMessage: 'failed',
      },
    }), runtimeConfig)).toThrow('只有幂等脚本可以自动重试')
  })

  it('reports an invalid configured interpreter without shell fallback', async () => {
    const instance = runtime({
      ...runtimeConfig,
      pythonExecutable: 'relative/python',
    })
    await expect(instance.status()).resolves.toMatchObject({
      available: false,
      reason: 'Python 解释器路径必须是绝对路径',
    })
  })

  it('validates AST and executes JSON input/output in an isolated process', async () => {
    const instance = runtime()
    const status = await instance.status()
    if (!status.available) return

    for (const source of [
      'import subprocess\ndef run(payload):\n    return payload\n',
      'import socket\ndef run(payload):\n    return payload\n',
      'import requests\ndef run(payload):\n    return payload\n',
      'import os\ndef run(payload):\n    return payload\n',
      'def run(payload):\n    return open("secret.txt").read()\n',
      'def run(payload):\n    return eval("1 + 1")\n',
      'value = 1\ndef run(payload):\n    return value\n',
    ]) {
      await expect(instance.validate(definition({ source }))).rejects.toThrow()
    }

    const output = await instance.execute(
      definition(),
      { value: 21 },
      new AbortController().signal
    )
    expect(output).toEqual({ value: 42 })
  })

  it('terminates timeout, cancellation and oversized output failures', async () => {
    const instance = runtime()
    const status = await instance.status()
    if (!status.available) return
    const runtimeDirectory = path.join(karinPathTemp, 'agent-script-runtime')
    const before = (await fs.readdir(runtimeDirectory).catch(() => []))
      .filter(name => name.startsWith('normalize_data-'))
      .sort()

    await expect(instance.execute(
      definition({
        source: 'def run(payload):\n    while True:\n        pass\n',
        stop: {
          ...definition().stop,
          timeoutMs: 1000,
        },
      }),
      {},
      new AbortController().signal
    )).rejects.toThrow('执行超时')

    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('cancelled by test')), 100)
    await expect(instance.execute(
      definition({ source: 'def run(payload):\n    while True:\n        pass\n' }),
      {},
      controller.signal
    )).rejects.toThrow('cancelled by test')

    await expect(instance.execute(
      definition({
        source: 'def run(payload):\n    return "x" * 5000\n',
        stop: {
          ...definition().stop,
          maxOutputBytes: 1024,
        },
      }),
      {},
      new AbortController().signal
    )).rejects.toThrow('输出超过 1024 bytes')

    const entries = await fs.readdir(runtimeDirectory).catch(() => [])
    expect(entries.filter(name => name.startsWith('normalize_data-')).sort()).toEqual(before)
  })

  it('retries only up to the declared maximum attempts', async () => {
    const instance = runtime()
    const invoke = vi.spyOn(
      instance as unknown as {
        invoke: (
          tool: AgentScriptToolDefinition,
          mode: 'validate' | 'execute',
          payload: unknown,
          signal: AbortSignal
        ) => Promise<unknown>
      },
      'invoke'
    )
    invoke
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('first failure'))
      .mockResolvedValueOnce({ value: 42 })

    await expect(instance.execute(
      definition({
        failure: {
          strategy: 'retry',
          maxAttempts: 2,
          retryDelayMs: 0,
          userMessage: 'Normalization failed',
        },
      }),
      { value: 21 },
      new AbortController().signal
    )).resolves.toEqual({ value: 42 })
    expect(invoke).toHaveBeenCalledTimes(3)
  })
})
