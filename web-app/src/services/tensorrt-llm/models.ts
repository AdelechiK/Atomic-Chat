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
 * 3. Download every file into `<data>/tensorrt-llm/models/<repository>/`, verified by size and LFS
 *    sha256, resuming partial files and skipping files already complete.
 * 4. Write `model.yml` last: a folder without one is a download in progress, not a model.
 */

import { invoke } from '@tauri-apps/api/core'
import { fs } from '@janhq/core'

import type {
  CheckpointFile,
  DescriptorSummary,
  ModelCompatibility,
} from '@/services/managed-environment/types'
import { transferFiles, type TransferItem, type TransferOptions } from '@/services/diffusion/transfer'

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
  /** Size of a file under the data folder, or null when it is not there. */
  existingSize: (savePath: string) => Promise<number | null>
  transfer: (items: TransferItem[], taskId: string, options: TransferOptions) => Promise<void>
  writeYaml: (savePath: string, data: unknown) => Promise<void>
}

export interface InstallRequest {
  repository: string
  revision?: string
  token?: string
  gpuId?: string
  onProgress?: (transferred: number, total: number) => void
}

/** The folder a repository's files go to; its path under `models/` is the model id. */
export function modelDir(repository: string): string {
  return `tensorrt-llm/models/${repository}`
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

  const dir = modelDir(repository)
  const pending: TransferItem[] = []
  for (const file of meta.files) {
    const savePath = `${dir}/${file.path}`
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
  if (pending.length > 0) {
    await deps.transfer(pending, `tensorrt-llm-${repository.replace(/[^A-Za-z0-9_-]/g, '_')}`, {
      resume: true,
      ...(request.token ? { hfToken: request.token } : {}),
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    })
  }

  // Last: this file is what turns the folder into a model for the core and the extension.
  await deps.writeYaml(`${dir}/model.yml`, {
    repository,
    revision: meta.revision,
    architectures: compatibility.architectures,
    quantization: compatibility.quantization_format,
    files: meta.files,
  })
  return { modelId: repository, compatibility }
}

function coreCall<T>(method: 'GET' | 'POST', path: string, body: unknown = null): Promise<T> {
  return invoke<T>('atomic_core_call', { method, path, body })
}

export function checkTensorrtModel(request: Parameters<InstallDeps['check']>[0]): Promise<ModelCompatibility> {
  return coreCall('POST', '/models/tensorrt-llm/check', request)
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
    existingSize: async (savePath) => {
      try {
        const stat = await fs.fileStat(`file:/${savePath}`)
        return stat && !stat.isDirectory ? Number(stat.size) : null
      } catch {
        return null
      }
    },
    transfer: transferFiles,
    writeYaml: (savePath, data) => invoke<void>('write_yaml', { data, savePath }),
  }
}
