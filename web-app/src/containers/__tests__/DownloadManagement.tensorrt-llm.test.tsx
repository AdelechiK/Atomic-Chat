import { render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadEvent } from '@janhq/core'

// Task 3.18 (manual run finding F-10): a TensorRT-LLM model download left the "Validating Model"
// toast the Rust downloader opens spinning forever, because nothing ended the download's events.

const toast = vi.hoisted(() => ({
  loading: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  dismiss: vi.fn(),
}))

vi.mock('sonner', () => ({ toast }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))
vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ models: () => ({ abortDownload: vi.fn() }) }),
  getServiceHub: () => ({}),
}))
const appUpdater = vi.hoisted(() => ({
  updateState: {
    isDownloading: false,
    downloadProgress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
  },
}))
vi.mock('@/hooks/useAppUpdater', () => ({ useAppUpdater: () => appUpdater }))
vi.mock('@/containers/downloads/DownloadPanel', () => ({
  DownloadPanel: () => null,
}))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
vi.mock('@/lib/sentry', () => ({ captureHandledError: vi.fn() }))

import { DownloadManagement } from '../DownloadManegement'
import { installTensorrtModel, type InstallDeps } from '@/services/tensorrt-llm/models'
import type { TransferItem } from '@/services/diffusion/transfer'

const REPO = 'Qwen/Qwen3-1.7B'
const SHA = 'c0ffee' + '0'.repeat(34)
const VALIDATION_TOAST = `model-validation-started-${REPO}`

/** Hugging Face with one small repository: a config and one LFS weight file. */
async function hf(url: string): Promise<Response> {
  if (url.startsWith(`https://huggingface.co/api/models/${REPO}/revision/`)) {
    return Response.json({
      sha: SHA,
      siblings: [
        { rfilename: 'config.json', size: 700 },
        {
          rfilename: 'model.safetensors',
          size: 134,
          lfs: { sha256: 'a'.repeat(64), size: 4_000_000_000 },
        },
      ],
    })
  }
  if (url.endsWith('/config.json')) return Response.json({ architectures: ['Qwen3ForCausalLM'] })
  return new Response('not found', { status: 404 })
}

describe('DownloadManagement — a TensorRT-LLM model download (task 3.18)', () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  const emit = (name: string, payload: unknown) =>
    handlers.get(name)?.forEach((handler) => handler(payload))

  /** The Rust downloader: the files arrive, it announces validation for the items' `model_id`. */
  function downloader(outcome: 'verified' | Error) {
    return async (items: TransferItem[]) => {
      emit(DownloadEvent.onModelValidationStarted, {
        modelId: items[0].model_id,
        downloadType: 'Model',
      })
      if (outcome !== 'verified') throw outcome
    }
  }

  function install(outcome: 'verified' | Error) {
    const deps: InstallDeps = {
      fetch: hf as typeof fetch,
      check: async () => ({
        architectures: ['Qwen3ForCausalLM'],
        quantization_format: null,
        weight_bytes: 4_000_000_000,
        checked_gpu_id: 'GPU-1',
        curated: true,
        unified_memory: false,
        fits_other_gpus: [],
        verdict: { ok: true },
      }),
      location: async () => ({ root: '/data/tensorrt-llm/models', free_bytes: null }),
      existingSize: async () => null,
      transfer: downloader(outcome),
      writeYaml: async () => {},
      emit,
    }
    return installTensorrtModel({ repository: REPO }, deps)
  }

  beforeEach(() => {
    handlers.clear()
    Object.values(toast).forEach((fn) => fn.mockClear())
    const core = ((globalThis as unknown as { core?: Record<string, unknown> })
      .core ??= {})
    core.events = {
      on: (name: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set())
        handlers.get(name)!.add(handler)
      },
      off: (name: string, handler: (payload: unknown) => void) => {
        handlers.get(name)?.delete(handler)
      },
      emit,
    }
  })

  afterEach(() => {
    delete (globalThis as unknown as { core: Record<string, unknown> }).core
      .events
  })

  it('closes the "Validating Model" toast once every file is verified and says it is downloaded and verified', async () => {
    render(<DownloadManagement />)

    await install('verified')

    const opened = toast.info.mock.calls.map(([, options]) => options?.id)
    expect(opened).toEqual([VALIDATION_TOAST])
    expect(toast.dismiss.mock.calls).toContainEqual([VALIDATION_TOAST])
    expect(toast.success.mock.calls.map(([title]) => title)).toEqual([
      'common:toast.downloadAndVerificationComplete.title',
    ])
    expect(toast.error.mock.calls).toEqual([])
  })

  it('closes it with the validation-failure toast when a file fails its sha256 check', async () => {
    render(<DownloadManagement />)

    await expect(
      install(new Error('Hash verification failed for model.safetensors'))
    ).rejects.toThrow('Hash verification failed')

    expect(toast.dismiss.mock.calls).toContainEqual([VALIDATION_TOAST])
    expect(toast.error.mock.calls.map(([title]) => title)).toEqual([
      'common:toast.modelValidationFailed.title',
    ])
    expect(toast.success.mock.calls).toEqual([])
  })
})
