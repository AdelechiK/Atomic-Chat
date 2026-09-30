import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

const navigate = vi.hoisted(() => vi.fn())
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }))

import { TensorrtLlmHubHint } from '../TensorrtLlmHubHint'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'
import type {
  EnvironmentSnapshot,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

function environment(overrides: Partial<EnvironmentSnapshot> = {}): EnvironmentSnapshot {
  return {
    schema_version: 1,
    environment_id: 'default',
    instance_id: 'core-a',
    revision: 1,
    executor: 'linux-docker',
    availability: 'setup-required',
    gpus: [],
    blockers: [],
    selinux: false,
    installations: [],
    active_operation_id: null,
    minimum_app_version: null,
    ...overrides,
  }
}

const installedEngine: RuntimeInstallation = {
  installation_id: 'tensorrt-llm',
  engine_id: 'tensorrt-llm',
  environment_id: 'default',
  active_descriptor_id: 'tensorrt-llm-1.2.1-r1',
  candidate_descriptor_id: null,
  availability: 'supported',
  status: 'ready',
}

function given(options: { providerShown: boolean; environment?: EnvironmentSnapshot }) {
  useModelProvider.setState({
    providers: options.providerShown
      ? ([{ provider: 'tensorrt-llm', active: true, models: [], settings: [] }] as unknown as ModelProvider[])
      : [],
  })
  useManagedEnvironmentStore.getState().reset()
  if (options.environment) {
    useManagedEnvironmentStore.getState().applySnapshot({
      instance_id: 'core-a',
      environments: [options.environment],
      environment_operations: [],
    })
  }
}

describe('TensorrtLlmHubHint (task 3.16)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('leads to choosing a model on the provider page once the engine is installed', () => {
    // spec "Движок установлен".
    given({
      providerShown: true,
      environment: environment({ availability: 'supported', installations: [installedEngine] }),
    })
    render(<TensorrtLlmHubHint />)

    expect(screen.getByText('hub:tensorrt.title')).toBeInTheDocument()
    expect(screen.getByText('hub:tensorrt.choose-model.body')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'hub:tensorrt.choose-model.action' }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/providers/$providerName',
      params: { providerName: 'tensorrt-llm' },
    })
  })

  it('leads to the install, saying what it involves, when the engine is not installed', () => {
    given({ providerShown: true, environment: environment() })
    render(<TensorrtLlmHubHint />)

    expect(screen.getByText('hub:tensorrt.install.body')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'hub:tensorrt.install.action' }))
    expect(navigate).toHaveBeenCalledWith({
      to: '/settings/providers/$providerName',
      params: { providerName: 'tensorrt-llm' },
    })
  })

  it('says something on the machine has to change first when the core is blocked', () => {
    given({
      providerShown: true,
      environment: environment({ availability: 'prerequisite-blocked' }),
    })
    render(<TensorrtLlmHubHint />)

    expect(screen.getByText('hub:tensorrt.blocked.body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'hub:tensorrt.blocked.action' })).toBeInTheDocument()
  })

  it('is not there when the provider is hidden (no NVIDIA card, not Linux, no descriptor)', () => {
    // spec "Нет карты NVIDIA".
    given({ providerShown: false, environment: environment({ availability: 'prerequisite-blocked' }) })
    const { container } = render(<TensorrtLlmHubHint />)

    expect(container).toBeEmptyDOMElement()
  })

  it('says nothing before the core has described the machine', () => {
    given({ providerShown: true })
    const { container } = render(<TensorrtLlmHubHint />)

    expect(container).toBeEmptyDOMElement()
  })
})
