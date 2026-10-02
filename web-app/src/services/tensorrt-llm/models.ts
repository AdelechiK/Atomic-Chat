/**
 * Getting a TensorRT-LLM model onto disk (spec `tensorrt-llm-models`, `tensorrt-llm-desktop`,
 * "Выбор и скачивание модели"): the app downloads, the core decides whether a checkpoint can run.
 *
 * 1. Read the repository at a revision from Hugging Face — pinned to its commit, so every file is
 *    read and downloaded from the same tree: `config.json`, `hf_quant_config.json` when the
 *    repository has one, and every file with its size and LFS sha256. A refusal means the model is
 *    gated and its terms were not accepted: the person is sent to the model page.
 * 2. Ask the core (`POST /models/tensorrt-llm/check`, no network on its side). Incompatible means
 *    nothing is downloaded, and the reason — with numbers, and the other cards it would fit on —
 *    goes back to the person.
 * 3. Ask the core where models go and how much room there is (`GET /models/tensorrt-llm/location`,
 *    change `add-tensorrt-llm-windows`, design D6): `<data>/tensorrt-llm/models` on Linux, Atomic
 *    Chat's WSL distribution (`\\wsl.localhost\…`) on Windows. Without room for what is still to
 *    download, nothing is downloaded.
 * 4. Download every file into `<root>/<repository>/`, verified by size and LFS sha256, resuming
 *    partial files and skipping files already complete.
 * 5. Write `model.yml` last: a folder without one is a download in progress, not a model.
 * 6. End the download's events as a chat-model download ends them, so the "Validating Model"
 *    toast the downloader opened is closed: verified and done, or the reason it failed.
 */

import { invoke } from '@tauri-apps/api/core'
import { DownloadEvent, events, fs } from '@janhq/core'

import type {
  CheckpointFile,
  DescriptorSummary,
  ModelCompatibility,
} from '@/services/managed-environment/types'
import {
  isTransferValidationError,
  transferFiles,
  type TransferItem,
  type TransferOptions,
} from '@/services/diffusion/transfer'

const HF = 'https://huggingface.co'

/** Hugging Face refused access: the model is gated and its terms are not accepted with this token. */
export class GatedModelError extends Error {
  constructor(
    readonly repository: string,
    readonly url = `${HF}/${repository}`
  ) {
    super(`Access to ${repository} was refused.`)
    this.name = 'GatedModelError'
  }
}

/** The core's `check` said no; nothing was downloaded. */
export class IncompatibleModelError extends Error {
  constructor(readonly compatibility: ModelCompatibility) {
    super(compatibility.verdict.ok ? 'compatible' : compatibility.verdict.error.message)
    this.name = 'IncompatibleModelError'
  }

  get code(): string {
    return this.compatibility.verdict.ok ? '' : this.compatibility.verdict.error.code
  }

  /** Other cards on this machine the model would fit on, for "try the other card". */
  get fitsOtherGpus(): string[] {
    return this.compatibility.fits_other_gpus
  }
}

/** The core has less room for the model than is still to download; nothing was downloaded. */
export class InsufficientModelSpaceError extends Error {
  constructor(
    readonly root: string,
    readonly neededBytes: number,
    readonly freeBytes: number
  ) {
    super(`Not enough free space for the model in ${root}.`)
    this.name = 'InsufficientModelSpaceError'
  }
}

/**
 * `GET /models/tensorrt-llm/location`: the one root models are downloaded into, as this machine
 * opens it, and the free space for new models there (on Windows the smaller of the guest's and the
 * volume's that holds the distribution); `free_bytes` is null when the core could not measure it.
 */
export interface TensorrtLlmModelLocation {
  root: string
  free_bytes: number | null
}

export interface HfRevision {
  repository: string
  /** The commit the requested revision resolved to. */
  revision: string
  config_json: unknown
  hf_quant_config_json: unknown | null
  files: CheckpointFile[]
}

interface HfSibling {
  rfilename: string
  size?: number
  lfs?: { sha256?: string; size?: number }
}

function headers(token: string | undefined): HeadersInit {
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function hfJson(
  url: string,
  repository: string,
  token: string | undefined,
  fetchImpl: typeof fetch
): Promise<unknown> {
  const response = await fetchImpl(url, { headers: headers(token) })
  if (response.status === 401 || response.status === 403) throw new GatedModelError(repository)
  if (!response.ok) {
    throw new Error(`Hugging Face answered ${response.status} for ${url}`)
  }
  return response.json()
}

/**
 * The one id of a model's download (change `add-tensorrt-llm-model-hub`, design D6): the Rust task
 * id, each file's `model_id` and the download panel's row. Tauri takes only `[A-Za-z0-9_-]` in
 * the event name the task id ends up in.
 */
export function tensorrtDownloadId(repository: string): string {
  return `tensorrt-llm-${normalizeRepository(repository).replace(/[^A-Za-z0-9_-]/g, '_')}`
}

/** Normalises what a person pastes: a repo id or its huggingface.co URL. */
export function normalizeRepository(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\/(www\.)?huggingface\.co\//, '')
    .replace(/^huggingface\.co\//, '')
    .replace(/\/+$/, '')
}

export async function fetchHfRevision(
  repository: string,
  revision: string | undefined,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch
): Promise<HfRevision> {
  const listing = (await hfJson(
    `${HF}/api/models/${repository}/revision/${encodeURIComponent(revision ?? 'main')}?blobs=true&files_metadata=true`,
    repository,
    token,
    fetchImpl
  )) as { sha?: string; siblings?: HfSibling[] }
  if (!listing.sha) throw new Error(`Hugging Face did not name the commit of ${repository}`)
  const files: CheckpointFile[] = (listing.siblings ?? []).map((sibling) => ({
    path: sibling.rfilename,
    size: sibling.lfs?.size ?? sibling.size ?? 0,
    sha256: sibling.lfs?.sha256 ?? null,
  }))
  const resolve = (path: string) => `${HF}/${repository}/resolve/${listing.sha}/${path}`
  const has = (path: string) => files.some((file) => file.path === path)
  return {
    repository,
    revision: listing.sha,
    config_json: await hfJson(resolve('config.json'), repository, token, fetchImpl),
    hf_quant_config_json: has('hf_quant_config.json')
      ? await hfJson(resolve('hf_quant_config.json'), repository, token, fetchImpl)
      : null,
    files,
  }
}

export interface InstallDeps {
  fetch: typeof fetch
  check: (request: {
    repository: string
    revision: string
    config_json: unknown
    hf_quant_config_json: unknown | null
    files: CheckpointFile[]
    gpu_id?: string
  }) => Promise<ModelCompatibility>
  /** Where the core keeps the models, and the room there. */
  location: () => Promise<TensorrtLlmModelLocation>
  /** Size of a file (an absolute path), or null when it is not there. */
  existingSize: (savePath: string) => Promise<number | null>
  /** Whether a download of this file was started and left a partial (`<file>.tmp`) behind. */
  hasPartial: (savePath: string) => Promise<boolean>
  transfer: (items: TransferItem[], taskId: string, options: TransferOptions) => Promise<void>
  writeYaml: (savePath: string, data: unknown) => Promise<void>
  /** The app's download events (`events.emit`), which the download toasts follow. */
  emit: (event: string, payload: unknown) => void
}

export interface InstallRequest {
  repository: string
  revision?: string
  token?: string
  gpuId?: string
  onProgress?: (transferred: number, total: number) => void
}

/**
 * `relative` (a repository, a file path in it: `/`-separated) under `root`, spelled with the root's
 * own separator — a Windows UNC root gets backslashes throughout.
 */
export function underRoot(root: string, ...relative: string[]): string {
  const separator = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  const tail = relative.join('/').split('/').filter(Boolean).join(separator)
  return `${root.replace(/[\\/]+$/, '')}${separator}${tail}`
}

/** Checks, downloads and records one model; rejects before any download when it cannot run here. */
export async function installTensorrtModel(
  request: InstallRequest,
  deps: InstallDeps = defaultInstallDeps()
): Promise<{ modelId: string; compatibility: ModelCompatibility }> {
  const repository = normalizeRepository(request.repository)
  const meta = await fetchHfRevision(repository, request.revision, request.token, deps.fetch)
  const compatibility = await deps.check({
    repository,
    revision: meta.revision,
    config_json: meta.config_json,
    hf_quant_config_json: meta.hf_quant_config_json,
    files: meta.files,
    ...(request.gpuId ? { gpu_id: request.gpuId } : {}),
  })
  if (!compatibility.verdict.ok) throw new IncompatibleModelError(compatibility)

  // Only for a model that can run here; before Atomic Chat's distribution exists on Windows the
  // core refuses (`MANAGED_ADAPTER_UNAVAILABLE`) and nothing is downloaded.
  const { root, free_bytes: freeBytes } = await deps.location()
  const pending: TransferItem[] = []
  for (const file of meta.files) {
    const savePath = underRoot(root, repository, file.path)
    // Complete files are not fetched again; a partial one is resumed by the downloader.
    if ((await deps.existingSize(savePath)) === file.size) continue
    pending.push({
      url: `${HF}/${repository}/resolve/${meta.revision}/${file.path}`,
      save_path: savePath,
      size: file.size,
      model_id: repository,
      ...(file.sha256 ? { sha256: file.sha256 } : {}),
    })
  }
  const downloaded = pending.reduce((total, item) => total + (item.size ?? 0), 0)
  // The core's number, not the data folder's volume: on Windows the models live in the guest. A
  // resumed download needs only what its partials lack, which only the downloader can count
  // (`.parts` maps): it checks the same number then, so the app leaves that case to it.
  const resuming = (await Promise.all(pending.map((item) => deps.hasPartial(item.save_path)))).some(Boolean)
  if (freeBytes !== null && !resuming && freeBytes < downloaded) {
    throw new InsufficientModelSpaceError(root, downloaded, freeBytes)
  }
  try {
    if (pending.length > 0) {
      await deps.transfer(pending, tensorrtDownloadId(repository), {
        resume: true,
        ...(request.token ? { hfToken: request.token } : {}),
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
      })
    }

    // Last: this file is what turns the folder into a model for the core and the extension.
    await deps.writeYaml(underRoot(root, repository, 'model.yml'), {
      repository,
      revision: meta.revision,
      architectures: compatibility.architectures,
      quantization: compatibility.quantization_format,
      files: meta.files,
    })
  } catch (error) {
    if (pending.length > 0) emitDownloadFailed(deps, repository, error)
    throw error
  }
  // The Rust downloader opened a "Validating Model" toast for `repository` (each item's
  // `model_id`) once the files arrived, and only a terminal download event closes it (F-10).
  // Sent only after a download: with every file already on disk nothing was fetched or checked.
  if (pending.length > 0) {
    deps.emit(DownloadEvent.onFileDownloadAndVerificationSuccess, {
      modelId: repository,
      downloadType: 'Model',
      size: { transferred: downloaded, total: downloaded },
    })
  }
  return { modelId: repository, compatibility }
}

/**
 * Close the download's toasts as a failed chat-model download closes them: a file that failed its
 * size or sha256 check (the downloader has already removed it) as a validation failure, anything
 * else as a download error.
 */
function emitDownloadFailed(deps: InstallDeps, repository: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  if (isTransferValidationError(error)) {
    deps.emit(DownloadEvent.onModelValidationFailed, {
      modelId: repository,
      downloadType: 'Model',
      error: message,
      reason: 'validation_failed',
    })
  } else {
    deps.emit(DownloadEvent.onFileDownloadError, {
      modelId: repository,
      downloadType: 'Model',
      error: message,
    })
  }
}

function coreCall<T>(method: 'GET' | 'POST', path: string, body: unknown = null): Promise<T> {
  return invoke<T>('atomic_core_call', { method, path, body })
}

export function checkTensorrtModel(request: Parameters<InstallDeps['check']>[0]): Promise<ModelCompatibility> {
  return coreCall('POST', '/models/tensorrt-llm/check', request)
}

/** Where the core keeps TensorRT-LLM models on this machine, and the room there. */
export function tensorrtModelLocation(): Promise<TensorrtLlmModelLocation> {
  return coreCall('GET', '/models/tensorrt-llm/location')
}

/**
 * The curated models and NVIDIA notices of a descriptor the core has cached, by the id an
 * installation pins or a plan names. The core answers from its cache without the network; an id
 * it does not hold (404) or a core without managed runtimes (422) answers `null`, and the app shows
 * no curated list and says the notices were not reported.
 */
export async function describeDescriptor(descriptorId: string): Promise<DescriptorSummary | null> {
  try {
    return await coreCall<DescriptorSummary>(
      'GET',
      `/environments/descriptors/${encodeURIComponent(descriptorId)}`
    )
  } catch {
    return null
  }
}

export function defaultInstallDeps(): InstallDeps {
  return {
    fetch,
    check: checkTensorrtModel,
    location: tensorrtModelLocation,
    existingSize: async (savePath) => {
      try {
        const stat = await fs.fileStat(savePath)
        return stat && !stat.isDirectory ? Number(stat.size) : null
      } catch {
        return null
      }
    },
    hasPartial: async (savePath) => {
      try {
        return (await fs.fileStat(`${savePath}.tmp`)) != null
      } catch {
        return false
      }
    },
    transfer: transferFiles,
    writeYaml: (savePath, data) => invoke<void>('write_yaml', { data, savePath }),
    emit: (event, payload) => events.emit(event, payload),
  }
}
