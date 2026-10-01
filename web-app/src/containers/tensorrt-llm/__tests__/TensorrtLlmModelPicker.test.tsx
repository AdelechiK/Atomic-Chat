import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const models = vi.hoisted(() => ({
  fetchHfRevision: vi.fn(),
  checkTensorrtModel: vi.fn(),
  installTensorrtModel: vi.fn(),
  describeDescriptor: vi.fn(),
}))
vi.mock('@/services/tensorrt-llm/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tensorrt-llm/models')>()),
  ...models,
}))

const refresh = vi.hoisted(() => vi.fn(async () => {}))

import { TensorrtLlmModelPicker } from '../TensorrtLlmModelPicker'
import {
  GatedModelError,
  IncompatibleModelError,
  InsufficientModelSpaceError,
} from '@/services/tensorrt-llm/models'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'
import type { ModelCompatibility } from '@/services/managed-environment/types'

const compatible: ModelCompatibility = {
  architectures: ['Qwen3ForCausalLM'],
  quantization_format: 'fp8',
  weight_bytes: 8e9,
  checked_gpu_id: 'GPU-1',
  curated: false,
  unified_memory: false,
  fits_other_gpus: [],
  verdict: { ok: true },
}
const incompatible: ModelCompatibility = {
  ...compatible,
  fits_other_gpus: ['GPU-2'],
  verdict: {
    ok: false,
    error: { code: 'MODEL_INCOMPATIBLE', message: 'Needs compute capability 10.0, the card has 8.9.' },
  },
}

const meta = (repository: string) => ({
  repository,
  revision: 'abc',
  config_json: {},
  hf_quant_config_json: null,
  files: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  useGeneralSetting.setState({ huggingfaceToken: 'hf_secret' })
  useManagedEnvironmentStore.getState().reset()
  useManagedEnvironmentStore.getState().applySnapshot({
    instance_id: 'core-a',
    environments: [
      {
        schema_version: 1,
        environment_id: 'default',
        instance_id: 'core-a',
        revision: 1,
        executor: 'linux-docker',
        availability: 'supported',
        gpus: [
          { gpu_id: 'GPU-1', name: 'RTX 4070', compute_capability: '8.9', total_vram_bytes: 12e9, free_vram_bytes: 11e9, driver_version: '590' },
          { gpu_id: 'GPU-2', name: 'RTX 5090', compute_capability: '12.0', total_vram_bytes: 32e9, free_vram_bytes: 31e9, driver_version: '590' },
        ],
        blockers: [],
        selinux: false,
        installations: [
          {
            installation_id: 'tensorrt-llm',
            engine_id: 'tensorrt-llm',
            environment_id: 'default',
            active_descriptor_id: 'tensorrt-llm-1.2.1-r1',
            candidate_descriptor_id: null,
            availability: 'supported',
            status: 'ready',
          },
        ],
        active_operation_id: null,
        minimum_app_version: null,
      },
    ],
    environment_operations: [],
  })
  models.describeDescriptor.mockResolvedValue(null)
  models.fetchHfRevision.mockImplementation(async (repository: string) => meta(repository))
  models.checkTensorrtModel.mockResolvedValue(compatible)
  models.installTensorrtModel.mockResolvedValue({ modelId: 'x', compatibility: compatible })
})

function pasteAndCheck(repository: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value: repository } })
  fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.models.check' }))
}

describe('TensorrtLlmModelPicker', () => {
  it('says why a pasted model cannot run here, names the card it fits, and downloads nothing', async () => {
    // spec "Вставлен несовместимый репозиторий".
    models.checkTensorrtModel.mockResolvedValue(incompatible)
    render(<TensorrtLlmModelPicker onInstalled={refresh} />)

    pasteAndCheck('nvidia/Qwen3-8B-NVFP4')

    expect(await screen.findByText(/compute capability 10\.0, the card has 8\.9/)).toBeInTheDocument()
    expect(screen.getByText(/RTX 5090/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'providers:tensorrt.models.download' })).not.toBeInTheDocument()
    expect(models.installTensorrtModel).not.toHaveBeenCalled()
  })

  it('sends the person to the model page to accept its terms when access is refused', async () => {
    // spec "Gated-модель без принятых условий".
    models.fetchHfRevision.mockRejectedValue(new GatedModelError('meta-llama/Llama-3.3-70B-Instruct'))
    render(<TensorrtLlmModelPicker onInstalled={refresh} />)

    pasteAndCheck('meta-llama/Llama-3.3-70B-Instruct')

    const link = await screen.findByRole('link', { name: /providers:tensorrt.models.gated/ })
    expect(link).toHaveAttribute('href', 'https://huggingface.co/meta-llama/Llama-3.3-70B-Instruct')
  })

  it('downloads a compatible model with the Hugging Face token and lists it when done', async () => {
    render(<TensorrtLlmModelPicker onInstalled={refresh} />)
    pasteAndCheck('https://huggingface.co/nvidia/Qwen3-8B-FP8')

    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.models.download' }))

    await waitFor(() => expect(refresh).toHaveBeenCalled())
    expect(models.installTensorrtModel.mock.calls[0][0]).toMatchObject({
      repository: 'nvidia/Qwen3-8B-FP8',
      revision: 'abc',
      token: 'hf_secret',
    })
  })

  it('offers the curated models that fit this machine, at their pinned revision', async () => {
    models.describeDescriptor.mockResolvedValue({
      descriptor_id: 'tensorrt-llm-1.2.1-r1',
      engine_id: 'tensorrt-llm',
      notices: [],
      supported_architectures: [],
      curated_models: [
        { repository: 'nvidia/Qwen3-8B-FP8', revision: 'r-fits', inventory_digest: 'sha256:x', vram_tier_bytes: 12e9, note: '' },
        { repository: 'nvidia/Llama-3.3-70B-Instruct-NVFP4', revision: 'r-big', inventory_digest: 'sha256:y', vram_tier_bytes: 80e9, note: '' },
      ],
    })
    models.checkTensorrtModel.mockImplementation(async (request: { repository: string }) =>
      request.repository === 'nvidia/Qwen3-8B-FP8' ? compatible : incompatible
    )

    render(<TensorrtLlmModelPicker onInstalled={refresh} />)

    expect(await screen.findByText('nvidia/Qwen3-8B-FP8')).toBeInTheDocument()
    await waitFor(() => expect(models.checkTensorrtModel).toHaveBeenCalledTimes(2))
    expect(screen.queryByText('nvidia/Llama-3.3-70B-Instruct-NVFP4')).not.toBeInTheDocument()
    expect(models.describeDescriptor).toHaveBeenCalledWith('tensorrt-llm-1.2.1-r1')
    expect(models.fetchHfRevision).toHaveBeenCalledWith('nvidia/Qwen3-8B-FP8', 'r-fits', 'hf_secret')
  })

  it('checks the curated models side by side, not one after another', async () => {
    const curated = (repository: string) => ({
      repository,
      revision: 'r',
      inventory_digest: 'sha256:x',
      vram_tier_bytes: 12e9,
      note: '',
    })
    models.describeDescriptor.mockResolvedValue({
      descriptor_id: 'tensorrt-llm-1.2.1-r1',
      engine_id: 'tensorrt-llm',
      notices: [],
      supported_architectures: [],
      curated_models: [curated('a/one'), curated('b/two'), curated('c/three')],
    })
    const pending: Array<() => void> = []
    models.checkTensorrtModel.mockImplementation(
      () => new Promise((resolve) => pending.push(() => resolve(compatible)))
    )

    render(<TensorrtLlmModelPicker onInstalled={refresh} />)

    await waitFor(() => expect(models.checkTensorrtModel).toHaveBeenCalledTimes(3))
    pending.forEach((finish) => finish())
    expect(await screen.findByText('c/three')).toBeInTheDocument()
  })

  it('shows no curated list while the core does not report one', async () => {
    render(<TensorrtLlmModelPicker onInstalled={refresh} />)

    await waitFor(() => expect(models.describeDescriptor).toHaveBeenCalled())
    expect(screen.queryByText('providers:tensorrt.models.curated')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox')).toBeInTheDocument()
  })

  it('reports an install the core refused after the files were checked again', async () => {
    models.installTensorrtModel.mockRejectedValue(new IncompatibleModelError(incompatible))
    render(<TensorrtLlmModelPicker onInstalled={refresh} />)
    pasteAndCheck('nvidia/Qwen3-8B-FP8')

    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.models.download' }))

    expect(await screen.findByText(/the card has 8\.9/)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })

  describe('on Windows (change add-tensorrt-llm-windows)', () => {
    it('shows a warning of the check without withholding the download', async () => {
      // spec "Памяти VM меньше, чем весов": a warning, never a refusal (design D11).
      models.checkTensorrtModel.mockResolvedValue({
        ...compatible,
        warnings: [
          {
            code: 'wsl-vm-memory',
            message: 'The WSL VM has 16 GB of memory and the weights take 20 GB: loading will be slow. Raise memory= in .wslconfig.',
            params: { vm_memory_bytes: '16000000000', weight_bytes: '20000000000', wslconfig_memory: '' },
          },
        ],
      })
      render(<TensorrtLlmModelPicker onInstalled={refresh} />)
      pasteAndCheck('nvidia/Qwen3-32B-FP8')

      expect(await screen.findByText(/The WSL VM has 16 GB of memory/)).toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.models.download' }))
      await waitFor(() => expect(models.installTensorrtModel).toHaveBeenCalledTimes(1))
    })

    it('says where the model would go, what it needs and what is free when the core has no room', async () => {
      const root = '\\\\wsl.localhost\\AtomicChat\\var\\lib\\atomic-chat\\scopes\\k1\\models\\tensorrt-llm'
      models.installTensorrtModel.mockRejectedValue(new InsufficientModelSpaceError(root, 8 * 1024 ** 3, 6 * 1024 ** 3))
      render(<TensorrtLlmModelPicker onInstalled={refresh} />)
      pasteAndCheck('nvidia/Qwen3-8B-FP8')
      fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.models.download' }))

      const line = await screen.findByText(/providers:tensorrt.models.noSpace/)
      expect(line).toHaveTextContent('"needed":"8.0 GB"')
      expect(line).toHaveTextContent('"free":"6.0 GB"')
      expect(line).toHaveTextContent('wsl.localhost')
      expect(refresh).not.toHaveBeenCalled()
    })
  })
})
