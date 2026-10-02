/**
 * The core's verdict on one TensorRT-LLM checkpoint, as the Model Hub shows it (change
 * `add-tensorrt-llm-model-hub`, design D3, D5): the repository read at a revision from Hugging
 * Face, then `POST /models/tensorrt-llm/check`. Nothing about compatibility is decided here.
 *
 * Kept for the session by `repository@revision` — the curated list, a card opened again and the
 * download all ask the same question. Only the core's own answers are kept (`ok`, `incompatible`):
 * a refusal by Hugging Face changes once the person accepts the model's terms, and a network error
 * is not an answer at all.
 */

import type { ModelCompatibility } from '@/services/managed-environment/types'
import {
  checkTensorrtModel,
  fetchHfRevision,
  GatedModelError,
  type HfRevision,
} from '@/services/tensorrt-llm/models'

export type TensorrtVerdict =
  | { kind: 'ok'; meta: HfRevision; compatibility: ModelCompatibility }
  | { kind: 'incompatible'; compatibility: ModelCompatibility }
  | { kind: 'gated'; url: string }
  /** The core has less room where models go than the download needs (on Windows: the guest). */
  | { kind: 'no-space'; root: string; neededBytes: number; freeBytes: number }
  | { kind: 'error'; message: string }

export const errorText = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)

async function evaluate(
  repository: string,
  revision: string | undefined,
  token: string | undefined
): Promise<TensorrtVerdict> {
  try {
    const meta = await fetchHfRevision(repository, revision, token)
    const compatibility = await checkTensorrtModel({
      repository,
      revision: meta.revision,
      config_json: meta.config_json,
      hf_quant_config_json: meta.hf_quant_config_json,
      files: meta.files,
    })
    return compatibility.verdict.ok
      ? { kind: 'ok', meta, compatibility }
      : { kind: 'incompatible', compatibility }
  } catch (error) {
    if (error instanceof GatedModelError) return { kind: 'gated', url: error.url }
    return { kind: 'error', message: errorText(error) }
  }
}

const pending = new Map<string, Promise<TensorrtVerdict>>()
const settled = new Map<string, TensorrtVerdict>()

const keyOf = (repository: string, revision: string | undefined) =>
  `${repository}@${revision ?? 'main'}`

export function resetTensorrtVerdictsForTests(): void {
  pending.clear()
  settled.clear()
}

/** The verdict already held for this repository and revision, without asking. */
export function heldTensorrtVerdict(
  repository: string,
  revision: string | undefined
): TensorrtVerdict | undefined {
  return settled.get(keyOf(repository, revision))
}

/** The core's verdict, asked once per repository and revision while its answer stands. */
export function tensorrtVerdict(
  repository: string,
  revision: string | undefined,
  token: string | undefined
): Promise<TensorrtVerdict> {
  const key = keyOf(repository, revision)
  const held = settled.get(key)
  if (held) return Promise.resolve(held)
  const asking = pending.get(key)
  if (asking) return asking
  const promise = evaluate(repository, revision, token).then((verdict) => {
    pending.delete(key)
    if (verdict.kind === 'ok' || verdict.kind === 'incompatible') settled.set(key, verdict)
    return verdict
  })
  pending.set(key, promise)
  return promise
}

/** Runs on some card of this machine: here, or on another card the core names. */
export function runsOnSomeCard(verdict: TensorrtVerdict): boolean {
  return (
    verdict.kind === 'ok' ||
    (verdict.kind === 'incompatible' && verdict.compatibility.fits_other_gpus.length > 0)
  )
}
