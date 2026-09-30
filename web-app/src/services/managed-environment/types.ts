/**
 * The managed-runtime surface of `atomic-chat-core` 0.7.0 (control protocol 2) as the app reads it:
 * the container environment the core owns on Linux, the TensorRT-LLM installation inside it, the
 * durable operations that set it up and remove it, and the core's verdict on a checkpoint.
 *
 * A copy of the fields the app uses from the core's `src/contracts/environment.ts` (openspec change
 * `add-tensorrt-llm-linux`); snake_case because the core emits them so. Nothing here is computed by
 * the app: every value comes from the core, over `atomic_core_call` or a relayed event.
 */

export type Sha256Digest = `sha256:${string}`

export type ManagedPhase =
  | 'checking'
  | 'awaiting-consent'
  | 'preparing-host'
  | 'relogin-required'
  | 'reboot-required'
  | 'preparing-environment'
  | 'pulling-image'
  | 'verifying'
  | 'activating'
  | 'removing'
  | 'ready'
  | 'removed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

export type ManagedAvailability =
  | 'supported'
  | 'setup-required'
  | 'prerequisite-blocked'
  | 'unsupported'

export type ManagedOperationKind = 'setup' | 'update' | 'remove'

export type ManagedOperationTarget =
  | { kind: 'environment' }
  | { kind: 'runtime'; installation_id: string; engine_id: string }

/** The core's error shape, as it arrives in an operation or a verdict. */
export interface ManagedError {
  code: string
  message: string
  details?: string
}

export interface ManagedProgress {
  label: string
  completed: number | null
  total: number | null
  unit: 'bytes' | 'steps' | 'unknown'
}

export interface GpuFacts {
  gpu_id: string
  name: string
  compute_capability: string
  total_vram_bytes: number | null
  free_vram_bytes: number | null
  driver_version: string | null
}

export interface RuntimeInstallation {
  installation_id: string
  engine_id: string
  environment_id: string
  active_descriptor_id: string | null
  candidate_descriptor_id: string | null
  availability: ManagedAvailability
  status: 'absent' | 'installing' | 'ready' | 'updating' | 'removing' | 'failed'
}

export interface ManagedBlocker extends ManagedError {
  reason?: string
  params?: Record<string, string>
  commands?: string[]
}

export interface EnvironmentSnapshot {
  schema_version: 1
  environment_id: string
  instance_id: string
  revision: number
  executor: 'linux-docker' | 'wsl-docker'
  availability: ManagedAvailability
  gpus: GpuFacts[]
  blockers: ManagedBlocker[]
  selinux: boolean | null
  installations: RuntimeInstallation[]
  active_operation_id: string | null
  minimum_app_version: string | null
}

export interface ContainerRuntimeStepParameters {
  user: string
  arch: 'x86_64' | 'aarch64'
  family: 'apt' | 'dnf'
  distro_id: string
  version_id: string
  components: string[]
}

export interface ManagedHostStep {
  step_id: string
  action: 'linux.install-container-runtime' | 'windows.enable-wsl'
  recipe_id: string
  recipe_digest: Sha256Digest
  parameters_digest: Sha256Digest
  parameters: ContainerRuntimeStepParameters
  nonce: string
  expected_operation_revision: number
}

export interface EnvironmentOperation {
  schema_version: 1
  operation_id: string
  request_id: string
  environment_id: string
  target: ManagedOperationTarget
  kind: ManagedOperationKind
  instance_id: string
  revision: number
  phase: ManagedPhase
  plan_digest: Sha256Digest | null
  approved_plan_digest: Sha256Digest | null
  carried_plan_digest: Sha256Digest | null
  progress: ManagedProgress | null
  pending_host_step: ManagedHostStep | null
  completed_step_ids: string[]
  cancellation_requested: boolean
  error: ManagedError | null
}

export interface ManagedSystemChange {
  code: string
  text: string
  params?: Record<string, string>
}

export interface RequirementPlan {
  plan_digest: Sha256Digest
  environment_id: string
  target: ManagedOperationTarget
  availability: ManagedAvailability
  recipe_id: string
  recipe_digest: Sha256Digest
  descriptor_id: string | null
  image_digest: Sha256Digest | null
  adopts_existing_engine: boolean
  system_changes: ManagedSystemChange[]
  download_bytes: number | null
  required_disk_bytes: number | null
  requires_elevation: boolean
  may_require_relogin: boolean
  may_require_reboot: boolean
  blockers: ManagedBlocker[]
  /**
   * Where Docker keeps images, the free space there, and the descriptor's NVIDIA notices. The
   * spec asks the app to show all three before consent, but the core does not report them yet
   * (gap G-app-1 in the openspec change): shown when present, and the plan says so when absent.
   */
  docker_root_dir?: string | null
  free_disk_bytes?: number | null
  notices?: string[]
}
