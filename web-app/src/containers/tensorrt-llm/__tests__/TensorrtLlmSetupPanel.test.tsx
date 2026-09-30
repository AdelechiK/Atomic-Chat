import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Keys and their parameters are what the panel decides; the English copy lives in the locale file.
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key} ${JSON.stringify(params)}` : key,
  }),
}))

const client = vi.hoisted(() => ({
  probe: vi.fn(),
  beginOperation: vi.fn(),
  resumeOperation: vi.fn(),
  cancelOperation: vi.fn(),
  runHostStep: vi.fn(),
}))
const descriptors = vi.hoisted(() => ({ describeDescriptor: vi.fn() }))
vi.mock('@/services/tensorrt-llm/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/tensorrt-llm/models')>()),
  ...descriptors,
}))
vi.mock('@/services/managed-environment/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/managed-environment/client')>()),
  ...client,
}))

import { resetHostStepPromptsForTests, TensorrtLlmSetupPanel } from '../TensorrtLlmSetupPanel'
import { useManagedEnvironmentStore } from '@/stores/managed-environment-store'
import type {
  EnvironmentOperation,
  EnvironmentSnapshot,
  RequirementPlan,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

const digest = ('sha256:' + 'a'.repeat(64)) as RequirementPlan['plan_digest']

function plan(overrides: Partial<RequirementPlan> = {}): RequirementPlan {
  return {
    plan_digest: digest,
    environment_id: 'default',
    target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    availability: 'setup-required',
    recipe_id: 'linux.install-container-runtime',
    recipe_digest: digest,
    descriptor_id: 'tensorrt-llm-1.2.1-r1',
    image_digest: digest,
    adopts_existing_engine: false,
    system_changes: [
      {
        code: 'add-user-to-docker-group',
        text: 'Add ann to the docker group. This grants access equivalent to root on this machine.',
      },
    ],
    download_bytes: 21 * 1024 ** 3,
    required_disk_bytes: 63 * 1024 ** 3,
    requires_elevation: true,
    may_require_relogin: true,
    may_require_reboot: false,
    blockers: [],
    ...overrides,
  }
}

function operation(overrides: Partial<EnvironmentOperation> = {}): EnvironmentOperation {
  return {
    schema_version: 1,
    operation_id: 'op-1',
    request_id: 'req-1',
    environment_id: 'default',
    target: { kind: 'runtime', installation_id: 'tensorrt-llm', engine_id: 'tensorrt-llm' },
    kind: 'setup',
    instance_id: 'core-a',
    revision: 1,
    phase: 'checking',
    plan_digest: null,
    approved_plan_digest: null,
    carried_plan_digest: null,
    progress: null,
    pending_host_step: null,
    completed_step_ids: [],
    cancellation_requested: false,
    error: null,
    ...overrides,
  }
}

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

const store = () => useManagedEnvironmentStore.getState()

function seed(env: EnvironmentSnapshot, operations: EnvironmentOperation[] = []) {
  store().applySnapshot({ instance_id: 'core-a', environments: [env], environment_operations: operations })
}

/** The core's next word on the operation, as the relay delivers it. */
function coreSays(op: EnvironmentOperation) {
  act(() => {
    store().applyEnvironment(
      environment({ revision: op.revision + 100, active_operation_id: op.operation_id })
    )
    store().applyOperation(op)
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  resetHostStepPromptsForTests()
  store().reset()
  seed(environment())
  client.probe.mockResolvedValue(plan())
  client.beginOperation.mockResolvedValue(operation())
  client.resumeOperation.mockResolvedValue(operation())
  client.cancelOperation.mockResolvedValue(operation())
  client.runHostStep.mockResolvedValue({ outcome: 'completed' })
  descriptors.describeDescriptor.mockResolvedValue(null)
})

describe('TensorrtLlmSetupPanel', () => {
  it('shows the whole plan and installs nothing when the person closes it', async () => {
    // spec "Отказ от согласия".
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText(/grants access equivalent to root/)).toBeInTheDocument()
    expect(within(dialog).getByText(/providers:tensorrt.plan.relogin/)).toBeInTheDocument()
    expect(within(dialog).getByText(/providers:tensorrt.plan.download/)).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'providers:tensorrt.plan.cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(client.beginOperation).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'providers:tensorrt.install' })).toBeInTheDocument()
  })

  it('shows the NVIDIA notices of the descriptor the plan installs, and says so when the core has none', async () => {
    descriptors.describeDescriptor.mockResolvedValue({
      descriptor_id: 'tensorrt-llm-1.2.1-r1',
      engine_id: 'tensorrt-llm',
      notices: ['Use of the NGC container is subject to the NVIDIA AI Product Agreement.'],
      curated_models: [],
      supported_architectures: [],
    })
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))

    const dialog = await screen.findByRole('dialog')
    expect(await within(dialog).findByText(/NVIDIA AI Product Agreement/)).toBeInTheDocument()
    expect(descriptors.describeDescriptor).toHaveBeenCalledWith('tensorrt-llm-1.2.1-r1')
    expect(within(dialog).queryByText('providers:tensorrt.plan.noticesMissing')).not.toBeInTheDocument()
  })

  it('on consent starts the setup, approves exactly the plan it showed, asks for the system password and then explains the sign-in', async () => {
    // spec "Чистая Ubuntu с драйвером".
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'providers:tensorrt.plan.agree' })
    )

    await waitFor(() => expect(client.beginOperation).toHaveBeenCalledTimes(1))
    expect(client.beginOperation.mock.calls[0][1]).toMatchObject({
      kind: 'setup',
      descriptor_id: 'tensorrt-llm-1.2.1-r1',
    })

    coreSays(operation({ phase: 'awaiting-consent', revision: 2, plan_digest: digest }))
    await waitFor(() => expect(client.resumeOperation).toHaveBeenCalledWith('op-1', 2, digest))

    coreSays(
      operation({
        phase: 'preparing-host',
        revision: 3,
        pending_host_step: { step_id: 'step-1' } as EnvironmentOperation['pending_host_step'],
      })
    )
    await waitFor(() => expect(client.runHostStep).toHaveBeenCalledWith('op-1'))

    coreSays(operation({ phase: 'relogin-required', revision: 4 }))
    expect(await screen.findByText('providers:tensorrt.relogin.title')).toBeInTheDocument()
    // One prompt per step, however often the panel renders.
    expect(client.runHostStep).toHaveBeenCalledTimes(1)
  })

  it('does not approve a plan it did not show', async () => {
    // The machine changed between the probe and the consent: the core offers another plan.
    render(<TensorrtLlmSetupPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'providers:tensorrt.install' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'providers:tensorrt.plan.agree' })
    )
    await waitFor(() => expect(client.beginOperation).toHaveBeenCalled())

    const other = ('sha256:' + 'b'.repeat(64)) as RequirementPlan['plan_digest']
    client.probe.mockResolvedValue(plan({ plan_digest: other }))
    coreSays(operation({ phase: 'awaiting-consent', revision: 2, plan_digest: other }))

    // The new plan is shown for a fresh consent instead.
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(client.resumeOperation).not.toHaveBeenCalled()
  })

  it('finds a running pull as it is after the window was closed, with bytes and a cancel', async () => {
    // spec "Закрыли окно и открыли снова".
    seed(environment({ active_operation_id: 'op-1' }), [
      operation({
        phase: 'pulling-image',
        revision: 9,
        progress: { label: 'pull', completed: 5 * 1024 ** 3, total: 21 * 1024 ** 3, unit: 'bytes' },
      }),
    ])

    render(<TensorrtLlmSetupPanel />)

    expect(await screen.findByText('providers:tensorrt.phase.pulling-image')).toBeInTheDocument()
    expect(screen.getByText(/5\.0 GB/)).toBeInTheDocument()
    expect(screen.getByText(/21\.0 GB/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.cancel' }))
    await waitFor(() => expect(client.cancelOperation).toHaveBeenCalledWith('op-1'))
  })

  it('shows where the image would go, what it needs and what is free, and offers no install without room', async () => {
    // spec "Нет места под образ".
    client.probe.mockResolvedValue(
      plan({
        availability: 'prerequisite-blocked',
        docker_root_dir: '/var/lib/docker',
        blockers: [
          {
            code: 'MANAGED_PREREQUISITE_BLOCKED',
            message: 'There is not enough free disk space for the runtime image.',
            reason: 'insufficient-disk',
            params: { free: String(20 * 1024 ** 3), required: String(63 * 1024 ** 3) },
          },
        ],
      })
    )

    render(<TensorrtLlmSetupPanel />)

    expect(await screen.findByText(/\/var\/lib\/docker/)).toBeInTheDocument()
    expect(screen.getByText(/63\.0 GB/)).toBeInTheDocument()
    expect(screen.getByText(/20\.0 GB/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'providers:tensorrt.install' })).not.toBeInTheDocument()
  })

  it('explains a card older than Ampere and checks again on request', async () => {
    // spec "Карта старше Ampere".
    client.probe.mockResolvedValue(
      plan({
        availability: 'prerequisite-blocked',
        blockers: [
          {
            code: 'MANAGED_PREREQUISITE_BLOCKED',
            message: 'Needs compute capability 8.0 or newer (Ampere+); the best card here has 7.5.',
            reason: 'compute-capability-too-low',
            params: { required: '8.0', actual: '7.5' },
          },
        ],
      })
    )

    render(<TensorrtLlmSetupPanel />)

    expect(
      await screen.findByText('providers:tensorrt.blocker.ampere {"required":"8.0","actual":"7.5"}')
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.checkAgain' }))
    await waitFor(() => expect(client.probe).toHaveBeenCalledTimes(2))
  })

  it('hands over the exact sudo command when there is no system prompt to show', async () => {
    client.runHostStep.mockResolvedValue({
      outcome: 'manual',
      command: 'sudo /run/user/1000/x/atomic-chat-core host-step exec /run/user/1000/x/step-1.request.json',
    })
    seed(environment({ active_operation_id: 'op-1' }), [
      operation({
        phase: 'preparing-host',
        revision: 3,
        pending_host_step: { step_id: 'step-1' } as EnvironmentOperation['pending_host_step'],
      }),
    ])

    render(<TensorrtLlmSetupPanel />)

    expect(
      await screen.findByText(
        'sudo /run/user/1000/x/atomic-chat-core host-step exec /run/user/1000/x/step-1.request.json'
      )
    ).toBeInTheDocument()
  })

  it('answers a removal still waiting for consent with the removal dialog, not a setup plan', async () => {
    // The page was left while the core prepared the removal: nothing here remembers the consent.
    seed(environment({ installations: [installedEngine], active_operation_id: 'op-1' }), [
      operation({ kind: 'remove', phase: 'awaiting-consent', revision: 2, plan_digest: digest }),
    ])

    render(<TensorrtLlmSetupPanel />)

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('providers:tensorrt.remove.title')).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'providers:tensorrt.remove.confirm' }))
    await waitFor(() => expect(client.resumeOperation).toHaveBeenCalledWith('op-1', 2, digest))
    expect(client.beginOperation).not.toHaveBeenCalled()
  })

  it('never asks for the system password twice for one step, even after the page opens again', async () => {
    let finish!: (answer: { outcome: string }) => void
    client.runHostStep.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    seed(environment({ active_operation_id: 'op-1' }), [
      operation({
        phase: 'preparing-host',
        revision: 3,
        pending_host_step: { step_id: 'step-9' } as EnvironmentOperation['pending_host_step'],
      }),
    ])

    const first = render(<TensorrtLlmSetupPanel />)
    await waitFor(() => expect(client.runHostStep).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'providers:tensorrt.hostStep.retry' })).toBeDisabled()
    first.unmount()
    render(<TensorrtLlmSetupPanel />)
    await screen.findByText('providers:tensorrt.phase.preparing-host')

    expect(client.runHostStep).toHaveBeenCalledTimes(1)
    finish({ outcome: 'declined' })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'providers:tensorrt.hostStep.retry' })).toBeEnabled()
    )
  })

  it('says what removing the engine frees, that uninstalling the app does not, and keeps models by default', async () => {
    seed(environment({ installations: [installedEngine] }))

    render(<TensorrtLlmSetupPanel />)

    expect(await screen.findByText(/providers:tensorrt.remove.space/)).toHaveTextContent('63.0 GB')
    fireEvent.click(screen.getByRole('button', { name: 'providers:tensorrt.remove.button' }))
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'providers:tensorrt.remove.confirm' })
    )
    await waitFor(() =>
      expect(client.beginOperation.mock.calls[0][1]).toMatchObject({ kind: 'remove', retain_models: true })
    )

    // The person confirmed exactly this removal; the core's consent step is approved as it asks.
    coreSays(operation({ kind: 'remove', phase: 'awaiting-consent', revision: 2, plan_digest: digest }))
    await waitFor(() => expect(client.resumeOperation).toHaveBeenCalledWith('op-1', 2, digest))
  })
})
