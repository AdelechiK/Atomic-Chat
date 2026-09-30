import { beforeEach, describe, expect, it, vi } from 'vitest'

// The TensorRT-LLM runtime lives in `atomic-chat-core`: availability, loads, unloads, sessions and
// capabilities are control calls through `atomic_core_call`, and the model folders are read the
// way every engine extension reads its own. `invoke` answers only those, so any other command
// fails the test.

const { invokeMock, listenMock, fsMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  listenMock: vi.fn(async () => () => {}),
  fsMock: {
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    fileStat: vi.fn(),
    mkdir: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }))
vi.mock('@tauri-apps/plugin-log', () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@janhq/core', () => ({
  AIEngine: class AIEngine {
    registerSettings(_: unknown) {}
    getSetting<T>(_: string, def: T) {
      return Promise.resolve(def)
    }
    async getSettings() {
      return []
    }
    async updateSettings(_: unknown) {}
    onLoad() {}
  },
  getJanDataFolderPath: vi.fn().mockResolvedValue('/data'),
  joinPath: vi.fn((parts: string[]) => Promise.resolve(parts.join('/'))),
  fs: fsMock,
}))

;(globalThis as { SETTINGS?: unknown }).SETTINGS = []

import TensorrtLlmExtension from './index'

type Route = (body: unknown) => unknown
function core(routes: Record<string, Route>, yaml: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string; body: unknown }> = []
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'atomic_core_status')
      return { running: true, attached: { instance_id: 'i', generation: 1 } }
    if (command === 'read_yaml') {
      const path = String(args?.['path'])
      if (!(path in yaml)) throw new Error(`no yaml at ${path}`)
      return yaml[path]
    }
    if (command === 'atomic_core_call') {
      const call = {
        method: String(args?.['method']),
        path: String(args?.['path']),
        body: args?.['body'],
      }
      calls.push(call)
      const route = routes[`${call.method} ${call.path}`]
      if (!route) throw new Error(`unrouted ${call.method} ${call.path}`)
      return route(call.body)
    }
    throw new Error(`unexpected command: ${command}`)
  })
  return calls
}

const plan = (availability: string, reasons: string[] = []) => ({
  availability,
  descriptor_id: 'tensorrt-llm-1.2.1-r1',
  blockers: reasons.map((reason) => ({
    code: reason === 'descriptor-unavailable' ? 'MANAGED_METADATA_INVALID' : 'MANAGED_PREREQUISITE_BLOCKED',
    message: reason,
    reason,
  })),
})
const noEnvironments = { 'GET /environments': () => ({ environments: [] }) }

const containerSession = {
  pid: null,
  port: 4001,
  model_id: 'qwen3-8b',
  model_path: '/data/tensorrt-llm/models/qwen3-8b',
  is_embedding: false,
  api_key: 'gateway-key',
  execution: 'container',
  generation: 'g-1',
}

const handover = {
  'POST /settings/tensorrt-llm/import': () => ({
    status: 'imported',
    applied: [],
    conflicts: [],
    revision: 1,
  }),
  'GET /settings/tensorrt-llm': () => ({ provider: 'tensorrt-llm', revision: 2, values: {} }),
  'POST /settings/tensorrt-llm/acknowledge': () => ({}),
}

beforeEach(() => {
  invokeMock.mockReset()
  fsMock.existsSync.mockReset()
  fsMock.readdirSync.mockReset()
  fsMock.fileStat.mockReset()
  fsMock.mkdir.mockReset()
})

describe('availability', () => {
  it('asks the core with the engine id before anything is installed, and hides the provider without an NVIDIA GPU', async () => {
    const calls = core({
      ...noEnvironments,
      'POST /environments/probe': () => plan('prerequisite-blocked', ['no-gpu']),
    })
    const extension = new TensorrtLlmExtension()

    await extension.onLoad()
    // The probe onLoad started is the one a caller waits on: one probe, not two.
    await extension.refreshVisibility()

    expect(extension.isHidden()).toBe(true)
    expect(calls.filter((c) => c.path === '/environments/probe')).toHaveLength(1)
    expect(calls.find((c) => c.path === '/environments/probe')?.body).toEqual({
      descriptor_id: 'tensorrt-llm',
      target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    })
  })

  it('does not hold the app start up waiting for the probe', async () => {
    // Every extension's onLoad is awaited before the UI renders, and a probe runs docker info,
    // nvidia-smi and a descriptor fetch.
    core({ ...noEnvironments, 'POST /environments/probe': () => new Promise(() => {}) })
    const extension = new TensorrtLlmExtension()

    await expect(extension.onLoad()).resolves.toBeUndefined()
    expect(extension.isHidden()).toBe(true)
  })

  it('shows the provider once the descriptor is published, on the next check', async () => {
    let answer = plan('prerequisite-blocked', ['descriptor-unavailable'])
    core({ ...noEnvironments, 'POST /environments/probe': () => answer })
    const extension = new TensorrtLlmExtension()
    await extension.onLoad()
    await extension.refreshVisibility()
    expect(extension.isHidden()).toBe(true)

    answer = plan('setup-required')

    await expect(extension.refreshVisibility()).resolves.toBe(true)
    expect(extension.isHidden()).toBe(false)
  })

  it('keeps a host with a blocker it can explain visible', async () => {
    core({
      ...noEnvironments,
      'POST /environments/probe': () => plan('prerequisite-blocked', ['compute-capability-too-low']),
    })
    const extension = new TensorrtLlmExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(true)
  })

  it('hides the provider when the core cannot answer at all', async () => {
    core({})
    const extension = new TensorrtLlmExtension()

    await expect(extension.refreshVisibility()).resolves.toBe(false)
  })
})

describe('models', () => {
  it('lists every folder with a model.yml, sized by its files, with tools only where the core says so', async () => {
    core(
      {
        'GET /models/tensorrt-llm/qwen3-8b/capabilities': () => ({ tools: true, reasoning: true }),
        'GET /models/tensorrt-llm/gemma/capabilities': () => ({ tools: false, reasoning: false }),
      },
      {
        '/data/tensorrt-llm/models/qwen3-8b/model.yml': {
          repository: 'Qwen/Qwen3-8B',
          revision: 'abc',
          architectures: ['Qwen3ForCausalLM'],
          files: [
            { path: 'model-00001.safetensors', size: 1000, sha256: 'a' },
            { path: 'config.json', size: 24, sha256: null },
          ],
        },
        '/data/tensorrt-llm/models/gemma/model.yml': {
          repository: 'google/gemma',
          files: [],
        },
      }
    )
    const root = '/data/tensorrt-llm/models'
    // `partial` is a download in progress: files, no model.yml yet.
    fsMock.existsSync.mockImplementation(async (path: string) =>
      [root, `${root}/qwen3-8b/model.yml`, `${root}/gemma/model.yml`].includes(path)
    )
    fsMock.readdirSync.mockImplementation(async (path: string) =>
      path === root ? [`${root}/qwen3-8b`, `${root}/gemma`, `${root}/partial`] : []
    )
    fsMock.fileStat.mockResolvedValue({ isDirectory: true })
    const extension = new TensorrtLlmExtension()

    const models = await extension.list()

    expect(models.map((m) => m.id).sort()).toEqual(['gemma', 'qwen3-8b'])
    const qwen = models.find((m) => m.id === 'qwen3-8b')
    expect(qwen).toMatchObject({
      name: 'Qwen/Qwen3-8B',
      providerId: 'tensorrt-llm',
      sizeBytes: 1024,
      capabilities: ['tools'],
    })
    expect(models.find((m) => m.id === 'gemma')?.capabilities).toBeUndefined()
  })

  it('answers tool support from the core, false when it cannot tell', async () => {
    core({
      'GET /models/tensorrt-llm/qwen3-8b/capabilities': () => ({ tools: true }),
    })
    const extension = new TensorrtLlmExtension()

    await expect(extension.isToolSupported('qwen3-8b')).resolves.toBe(true)
    await expect(extension.isToolSupported('gone')).resolves.toBe(false)
  })
})

describe('sessions', () => {
  it('hands the settings over, then loads through the core and returns its container session', async () => {
    const calls = core({
      ...handover,
      'POST /models/tensorrt-llm/qwen3-8b/load': () => ({ session: containerSession, created: true }),
    })
    const extension = new TensorrtLlmExtension()

    const session = await extension.load('qwen3-8b')

    expect(session).toMatchObject({ pid: null, port: 4001, api_key: 'gateway-key' })
    const paths = calls.map((c) => `${c.method} ${c.path}`)
    expect(paths.indexOf('POST /settings/tensorrt-llm/import')).toBeLessThan(
      paths.indexOf('POST /models/tensorrt-llm/qwen3-8b/load')
    )
  })

  it('unloads through the core and reports only its own sessions as loaded', async () => {
    const calls = core({
      'POST /models/tensorrt-llm/qwen3-8b/unload': () => ({ success: true }),
      'GET /sessions': () => ({
        sessions: [
          { ...containerSession, provider: 'tensorrt-llm' },
          { ...containerSession, model_id: 'other', pid: 5, provider: 'llamacpp-upstream' },
        ],
      }),
    })
    const extension = new TensorrtLlmExtension()

    await expect(extension.unload('qwen3-8b')).resolves.toEqual({ success: true })
    await expect(extension.getLoadedModels()).resolves.toEqual(['qwen3-8b'])
    expect(calls.map((c) => c.path)).toContain('/models/tensorrt-llm/qwen3-8b/unload')
  })

  it('chats through the session gateway with the session key', async () => {
    core({
      'GET /sessions': () => ({ sessions: [{ ...containerSession, provider: 'tensorrt-llm' }] }),
    })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'x', choices: [] }), { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)
    const extension = new TensorrtLlmExtension()

    await extension.chat({ model: 'qwen3-8b', messages: [], stream: false } as never)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:4001/v1/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer gateway-key')
    vi.unstubAllGlobals()
  })
})
