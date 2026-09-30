/**
 * What the TensorRT-LLM provider page shows, decided from the core's state alone: its last plan
 * for this machine, the setup or removal in progress, the installation, and the last setup that
 * failed. Pure, so each spec scenario (`tensorrt-llm-desktop`) is pinned by a test rather than by
 * a component.
 */

import type {
  EnvironmentOperation,
  ManagedBlocker,
  RequirementPlan,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

/** Where an operation in progress stands, as far as the person is concerned. */
export type OperationStep =
  /** The core asks for consent again (the machine changed under the plan). */
  | 'consent'
  /** The one privileged step waits for the OS authorization prompt. */
  | 'host-step'
  /** Docker group membership takes effect at the next sign-in. */
  | 'relogin'
  /** Checking, pulling, verifying, activating, removing, cancelling: work the core does alone. */
  | 'working'

export type SetupView =
  | { kind: 'checking' }
  | { kind: 'blocked'; blockers: BlockerView[] }
  | { kind: 'not-installed'; plan: RequirementPlan }
  | { kind: 'operation'; operation: EnvironmentOperation; step: OperationStep }
  | { kind: 'failed'; operation: EnvironmentOperation }
  | { kind: 'installed'; installation: RuntimeInstallation }

export interface SetupState {
  plan?: RequirementPlan
  /** The operation still running, if any (`selectSetupOperation`). */
  operation?: EnvironmentOperation
  installation?: RuntimeInstallation
  /** The last TensorRT-LLM operation that ended in `failed`. */
  failed?: EnvironmentOperation
}

/**
 * A running operation outranks everything: it is what the person is waiting on, and the plan may
 * already be stale because of it (the pull uses the disk the plan counted). Then the installed
 * engine, then a failure to retry, then what the last probe said.
 */
export function deriveSetupView(state: SetupState): SetupView {
  const { plan, operation, installation, failed } = state
  if (operation) return { kind: 'operation', operation, step: stepOf(operation) }
  if (installation?.status === 'ready') return { kind: 'installed', installation }
  if (failed) return { kind: 'failed', operation: failed }
  if (!plan) return { kind: 'checking' }
  if (plan.availability === 'unsupported' || plan.availability === 'prerequisite-blocked') {
    return { kind: 'blocked', blockers: plan.blockers.map(blockerView) }
  }
  return { kind: 'not-installed', plan }
}

function stepOf(operation: EnvironmentOperation): OperationStep {
  switch (operation.phase) {
    case 'awaiting-consent':
      return 'consent'
    case 'preparing-host':
      return operation.pending_host_step ? 'host-step' : 'working'
    case 'relogin-required':
      return 'relogin'
    default:
      return 'working'
  }
}

export interface BlockerView {
  message: string
  /** Exact shell commands for a manual fix (Arch, a group-only host). */
  commands: string[]
  /** A card older than Ampere: the capability it needs and the one it has. */
  ampere: { required: string; actual: string } | null
}

export function blockerView(blocker: ManagedBlocker): BlockerView {
  return {
    message: blocker.message,
    commands: blocker.commands ?? [],
    ampere:
      blocker.reason === 'compute-capability-too-low' &&
      blocker.params?.required &&
      blocker.params.actual
        ? { required: blocker.params.required, actual: blocker.params.actual }
        : null,
  }
}

export interface PlanSummary {
  /** The core's own words for each system change; warnings are the ones that bite later. */
  changes: Array<{ text: string; warning: boolean }>
  relogin: boolean
  downloadBytes: number | null
  disk: {
    path: string | null
    requiredBytes: number | null
    freeBytes: number | null
    insufficient: boolean
  }
  notices: string[]
  blockers: BlockerView[]
  /** Consent is offered only for a plan that can run. */
  canStart: boolean
}

/** Group membership is root-equivalent; a Docker restart stops the person's containers. */
const WARNING_CHANGES = new Set(['add-user-to-docker-group', 'restart-docker'])

/** `notices` are the NVIDIA notices of the plan's descriptor, when the core reported them. */
export function planSummary(plan: RequirementPlan, notices: string[] = []): PlanSummary {
  const disk = plan.blockers.find((b) => b.reason === 'insufficient-disk')
  const number = (value: string | undefined) =>
    value !== undefined && Number.isFinite(Number(value)) ? Number(value) : null
  return {
    changes: plan.system_changes.map((change) => ({
      text: change.text,
      warning: WARNING_CHANGES.has(change.code),
    })),
    relogin: plan.may_require_relogin,
    downloadBytes: plan.download_bytes,
    disk: {
      path: plan.docker_root_dir ?? null,
      requiredBytes: plan.required_disk_bytes ?? number(disk?.params?.required),
      freeBytes: plan.free_disk_bytes ?? number(disk?.params?.free),
      insufficient: disk !== undefined,
    },
    notices,
    blockers: plan.blockers.map(blockerView),
    canStart:
      plan.blockers.length === 0 &&
      plan.availability !== 'unsupported' &&
      plan.availability !== 'prerequisite-blocked',
  }
}
