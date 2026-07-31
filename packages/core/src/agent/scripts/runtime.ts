import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import Ajv from 'ajv'
import { karinPathTemp } from '@/root'

import type {
  AgentConfig,
  AgentScriptToolDefinition,
} from '@/types/agent'

const pythonWorker = String.raw`
import ast
import json
import sys

ALLOWED_MODULES = {
    "base64", "collections", "csv", "datetime", "decimal", "fractions",
    "functools", "hashlib", "itertools", "json", "math", "random",
    "re", "statistics", "string"
}
BLOCKED_CALLS = {"compile", "eval", "exec", "globals", "input", "locals", "open", "__import__"}
SAFE_BUILTINS = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "enumerate": enumerate, "Exception": Exception, "filter": filter,
    "float": float, "int": int, "isinstance": isinstance, "len": len,
    "list": list, "map": map, "max": max, "min": min, "range": range,
    "reversed": reversed, "round": round, "set": set, "sorted": sorted,
    "str": str, "sum": sum, "tuple": tuple, "TypeError": TypeError,
    "ValueError": ValueError, "zip": zip
}

def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".", 1)[0]
    if level or root not in ALLOWED_MODULES:
        raise ImportError("module is not allowed: " + name)
    return __import__(name, globals, locals, fromlist, level)

SAFE_BUILTINS["__import__"] = safe_import

def validate(source):
    tree = ast.parse(source, mode="exec")
    run_functions = []
    for node in tree.body:
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            names = [item.name for item in node.names] if isinstance(node, ast.Import) else [node.module or ""]
            for name in names:
                if name.split(".", 1)[0] not in ALLOWED_MODULES:
                    raise ValueError("module is not allowed: " + name)
        elif isinstance(node, ast.FunctionDef):
            if node.name == "run":
                run_functions.append(node)
        else:
            raise ValueError("top-level code only allows imports and function definitions")
    if len(run_functions) != 1:
        raise ValueError("script must define exactly one run(payload) function")
    run = run_functions[0]
    if len(run.args.args) != 1 or run.args.vararg or run.args.kwarg or run.decorator_list:
        raise ValueError("run must accept exactly one payload argument")
    for node in ast.walk(tree):
        if isinstance(node, (ast.AsyncFunctionDef, ast.Await, ast.ClassDef, ast.Global, ast.Nonlocal)):
            raise ValueError("async, class and global state are not allowed")
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id in BLOCKED_CALLS:
                raise ValueError("blocked call: " + node.func.id)
            if isinstance(node.func, ast.Attribute) and node.func.attr in {
                "popen", "spawn", "startfile", "system"
            }:
                raise ValueError("blocked call: " + node.func.attr)
        if isinstance(node, ast.Attribute) and node.attr.startswith("__"):
            raise ValueError("dunder attribute access is not allowed")
    return tree

def main():
    request = json.loads(sys.stdin.read())
    source = request["source"]
    tree = validate(source)
    if request["mode"] == "validate":
        print(json.dumps({"ok": True}, ensure_ascii=False))
        return
    namespace = {"__builtins__": SAFE_BUILTINS}
    exec(compile(tree, "<karin-script-tool>", "exec"), namespace, namespace)
    result = namespace["run"](request.get("payload"))
    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, separators=(",", ":")))

try:
    main()
except BaseException as error:
    print(json.dumps({
        "ok": False,
        "error": type(error).__name__,
        "message": str(error)
    }, ensure_ascii=False, separators=(",", ":")))
    raise SystemExit(1)
`

const ajv = new Ajv({ allErrors: true, strict: true })
export const scriptToolName = (skillId: string, scriptToolId: string) =>
  `skill.skill_${skillId.replace(/[^a-z0-9_-]/gi, '_').toLowerCase()}.${scriptToolId}`
const nonEmpty = (value: unknown, label: string, maximum: number) => {
  const result = String(value || '').trim()
  if (!result || result.length > maximum) {
    throw new Error(`${label}不能为空且不能超过 ${maximum} 字符`)
  }
  return result
}

export const normalizeScriptTool = (
  value: Partial<AgentScriptToolDefinition>,
  config: AgentConfig['scriptRuntime']
): AgentScriptToolDefinition => {
  const id = String(value.id || '').trim().toLowerCase()
  if (!/^[a-z][a-z0-9_-]{1,63}$/.test(id)) {
    throw new Error('Script Tool ID 必须以小写字母开头，只包含小写字母、数字、下划线或连字符')
  }
  if (value.runtime !== 'python') throw new Error('第一版 Script Tool 仅支持 Python')
  const source = nonEmpty(value.source, `Script Tool ${id} 源码`, 65536)
  const inputSchema = value.inputSchema
  const outputSchema = value.outputSchema
  if (!inputSchema || typeof inputSchema !== 'object' || Array.isArray(inputSchema)) {
    throw new Error(`Script Tool ${id} 缺少 inputSchema`)
  }
  if (outputSchema && (typeof outputSchema !== 'object' || Array.isArray(outputSchema))) {
    throw new Error(`Script Tool ${id} outputSchema 无效`)
  }
  try {
    ajv.compile(inputSchema)
    if (outputSchema) ajv.compile(outputSchema)
  } catch (error) {
    throw new Error(`Script Tool ${id} JSON Schema 无效`, { cause: error })
  }

  const semantics = value.semantics
  if (!semantics) throw new Error(`Script Tool ${id} 缺少业务语义`)
  if (!Array.isArray(semantics.sideEffects)) {
    throw new Error(`Script Tool ${id} sideEffects 必须是数组`)
  }
  if (semantics.sideEffects.length) {
    throw new Error(`Script Tool ${id} 第一版只允许无外部副作用的纯计算脚本`)
  }

  const stop = value.stop
  if (!stop) throw new Error(`Script Tool ${id} 缺少停止条件`)
  const timeoutMs = Math.max(
    1000,
    Math.min(Number(stop.timeoutMs) || config.defaultTimeoutMs, config.maxTimeoutMs)
  )
  const maxOutputBytes = Math.max(
    1024,
    Math.min(
      Number(stop.maxOutputBytes) || config.defaultMaxOutputBytes,
      config.maxOutputBytes
    )
  )

  const failure = value.failure
  if (!failure) throw new Error(`Script Tool ${id} 缺少失败策略`)
  const strategy = failure.strategy === 'retry' ? 'retry' : 'fail'
  const maxAttempts = strategy === 'retry'
    ? Math.max(2, Math.min(Number(failure.maxAttempts) || 2, 3))
    : 1
  if (strategy === 'retry' && !semantics.idempotent) {
    throw new Error(`Script Tool ${id} 只有幂等脚本可以自动重试`)
  }

  return {
    id,
    name: nonEmpty(value.name, `Script Tool ${id} 名称`, 100),
    description: nonEmpty(value.description, `Script Tool ${id} 描述`, 500),
    runtime: 'python',
    source,
    sourceHash: createHash('sha256').update(source).digest('hex'),
    inputSchema,
    outputSchema,
    semantics: {
      objective: nonEmpty(semantics.objective, `Script Tool ${id} 业务目标`, 1000),
      inputs: nonEmpty(semantics.inputs, `Script Tool ${id} 输入语义`, 1000),
      outputs: nonEmpty(semantics.outputs, `Script Tool ${id} 输出语义`, 1000),
      sideEffects: [],
      idempotent: Boolean(semantics.idempotent),
    },
    stop: {
      completionCondition: nonEmpty(
        stop.completionCondition,
        `Script Tool ${id} 完成条件`,
        1000
      ),
      timeoutMs,
      maxOutputBytes,
    },
    failure: {
      strategy,
      maxAttempts,
      retryDelayMs: Math.max(0, Math.min(Number(failure.retryDelayMs) || 0, 10000)),
      userMessage: nonEmpty(failure.userMessage, `Script Tool ${id} 失败提示`, 1000),
    },
  }
}

interface Interpreter {
  command: string
  args: string[]
  version: string
}

interface WorkerResponse {
  ok: boolean
  result?: unknown
  error?: string
  message?: string
}

export class AgentPythonRuntime {
  private interpreterCache:
    | { key: string; value: Interpreter | null; reason?: string }
    | undefined

  constructor (private readonly getConfig: () => AgentConfig) {}

  private async probe (command: string, args: string[]) {
    return new Promise<Interpreter | null>(resolve => {
      const child = spawn(command, [...args, '--version'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      const timer = setTimeout(() => child.kill(), 5000)
      child.stdout.on('data', chunk => { output += String(chunk) })
      child.stderr.on('data', chunk => { output += String(chunk) })
      child.once('error', () => {
        clearTimeout(timer)
        resolve(null)
      })
      child.once('close', code => {
        clearTimeout(timer)
        resolve(code === 0
          ? { command, args, version: output.trim() || 'Python' }
          : null)
      })
    })
  }

  private async interpreter () {
    const configured = this.getConfig().scriptRuntime.pythonExecutable
    const key = configured || '<auto>'
    if (this.interpreterCache?.key === key) return this.interpreterCache.value

    let candidates: Array<{ command: string; args: string[] }>
    if (configured) {
      if (!path.isAbsolute(configured)) {
        this.interpreterCache = {
          key,
          value: null,
          reason: 'Python 解释器路径必须是绝对路径',
        }
        return null
      }
      try {
        const stat = await fs.promises.stat(configured)
        if (!stat.isFile()) throw new Error('not a file')
      } catch {
        this.interpreterCache = {
          key,
          value: null,
          reason: '配置的 Python 解释器不存在或不是文件',
        }
        return null
      }
      candidates = [{ command: configured, args: [] }]
    } else {
      candidates = process.platform === 'win32'
        ? [{ command: 'python', args: [] }, { command: 'py', args: ['-3'] }]
        : [{ command: 'python3', args: [] }, { command: 'python', args: [] }]
    }

    for (const candidate of candidates) {
      const found = await this.probe(candidate.command, candidate.args)
      if (found) {
        this.interpreterCache = { key, value: found }
        return found
      }
    }
    this.interpreterCache = {
      key,
      value: null,
      reason: '未检测到可用的 Python 3 解释器',
    }
    return null
  }

  async status () {
    const interpreter = await this.interpreter()
    return {
      available: Boolean(interpreter),
      executable: interpreter?.command || this.getConfig().scriptRuntime.pythonExecutable,
      version: interpreter?.version,
      reason: interpreter ? undefined : this.interpreterCache?.reason,
    }
  }

  async validate (
    definition: AgentScriptToolDefinition,
    signal: AbortSignal = AbortSignal.timeout(15000)
  ) {
    const normalized = normalizeScriptTool(definition, this.getConfig().scriptRuntime)
    await this.invoke(
      normalized,
      'validate',
      undefined,
      AbortSignal.any([signal, AbortSignal.timeout(15000)])
    )
    return normalized
  }

  async execute (
    definition: AgentScriptToolDefinition,
    payload: Record<string, unknown>,
    signal: AbortSignal
  ) {
    const normalized = await this.validate(definition, signal)
    let lastError: Error | undefined
    for (let attempt = 1; attempt <= normalized.failure.maxAttempts; attempt++) {
      try {
        return await this.invoke(normalized, 'execute', payload, signal)
      } catch (error) {
        lastError = error as Error
        if (
          signal.aborted ||
          attempt >= normalized.failure.maxAttempts ||
          normalized.failure.strategy !== 'retry'
        ) break
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, normalized.failure.retryDelayMs)
          signal.addEventListener('abort', () => {
            clearTimeout(timer)
            reject(signal.reason || new Error('Script Tool 已取消'))
          }, { once: true })
        })
      }
    }
    throw new Error(`${normalized.failure.userMessage}：${lastError?.message || '执行失败'}`, {
      cause: lastError,
    })
  }

  private async invoke (
    definition: AgentScriptToolDefinition,
    mode: 'validate' | 'execute',
    payload: unknown,
    signal: AbortSignal
  ) {
    const interpreter = await this.interpreter()
    if (!interpreter) {
      throw new Error(this.interpreterCache?.reason || 'Python Runtime 不可用')
    }
    const directoryRoot = path.join(karinPathTemp, 'agent-script-runtime')
    await fs.promises.mkdir(directoryRoot, { recursive: true })
    const directory = await fs.promises.mkdtemp(
      path.join(directoryRoot, `${definition.id}-${randomUUID()}-`)
    )
    try {
      return await this.runProcess(
        interpreter,
        directory,
        {
          mode,
          source: definition.source,
          payload,
        },
        mode === 'validate' ? 15000 : definition.stop.timeoutMs,
        mode === 'validate' ? 16384 : definition.stop.maxOutputBytes,
        signal
      )
    } finally {
      await fs.promises.rm(directory, { recursive: true, force: true })
    }
  }

  private runProcess (
    interpreter: Interpreter,
    cwd: string,
    request: Record<string, unknown>,
    timeoutMs: number,
    maximumBytes: number,
    signal: AbortSignal
  ) {
    if (signal.aborted) {
      return Promise.reject(
        signal.reason instanceof Error ? signal.reason : new Error('Script Tool 已取消')
      )
    }
    return new Promise<unknown>((resolve, reject) => {
      let settled = false
      let terminationError: Error | undefined
      let stdout = Buffer.alloc(0)
      let stderr = Buffer.alloc(0)
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(result)
      }
      const terminate = (error: Error) => {
        if (settled || terminationError) return
        terminationError = error
        if (!child.kill()) finish(error)
      }
      const abort = () => terminate(
        signal.reason instanceof Error ? signal.reason : new Error('Script Tool 已取消')
      )
      const child = spawn(
        interpreter.command,
        [...interpreter.args, '-I', '-S', '-c', pythonWorker],
        {
          cwd,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: {
            PYTHONHASHSEED: '0',
            PYTHONIOENCODING: 'utf-8',
            PATH: process.env.PATH || '',
            SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || '',
            WINDIR: process.env.WINDIR || '',
          } as unknown as NodeJS.ProcessEnv,
        }
      )
      const timer = setTimeout(
        () => terminate(new Error(`Script Tool 执行超时（${timeoutMs}ms）`)),
        timeoutMs
      )
      signal.addEventListener('abort', abort, { once: true })
      child.once('error', error => finish(new Error('Python 子进程启动失败', { cause: error })))
      child.stdout.on('data', chunk => {
        stdout = Buffer.concat([stdout, Buffer.from(chunk)])
        if (stdout.byteLength > maximumBytes) {
          terminate(new Error(`Script Tool 输出超过 ${maximumBytes} bytes`))
        }
      })
      child.stderr.on('data', chunk => {
        stderr = Buffer.concat([stderr, Buffer.from(chunk)])
        if (stderr.byteLength > 16384) stderr = stderr.subarray(0, 16384)
      })
      child.once('close', code => {
        if (settled) return
        if (terminationError) {
          finish(terminationError)
          return
        }
        let response: WorkerResponse
        try {
          response = JSON.parse(stdout.toString('utf8')) as WorkerResponse
        } catch (error) {
          finish(new Error(
            `Python 返回了非法 JSON${stderr.length ? `：${stderr.toString('utf8')}` : ''}`,
            { cause: error }
          ))
          return
        }
        if (code !== 0 || !response.ok) {
          finish(new Error(
            `${response.error || 'PythonError'}：${response.message || '执行失败'}`
          ))
          return
        }
        finish(undefined, response.result)
      })
      child.stdin.end(JSON.stringify(request))
    })
  }
}
