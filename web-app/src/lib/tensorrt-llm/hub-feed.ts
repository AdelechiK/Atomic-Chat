/**
 * The Model Hub's cheap narrowing of the Hugging Face feed under the TensorRT-LLM format (change
 * `add-tensorrt-llm-model-hub`, design D4): from the listing alone, leave out what certainly cannot
 * run here — an architecture the descriptor does not support, or weights larger than every card.
 * It is not a verdict: the quantization format is never looked at, and the card asks the core.
 */

import type { GpuFacts } from '@/services/managed-environment/types'
import type { CatalogModel } from '@/services/models/types'

/** Bytes per element by safetensors dtype; `U8` of NVFP4 is already the packed bytes. */
const DTYPE_BYTES: Record<string, number> = {
  F64: 8,
  I64: 8,
  U64: 8,
  F32: 4,
  I32: 4,
  U32: 4,
  BF16: 2,
  F16: 2,
  I16: 2,
  U16: 2,
  I8: 1,
  U8: 1,
  BOOL: 1,
}

/**
 * A dtype not listed here (a newer packed format) counts at one byte: the estimate may only ever
 * be low, never hide a model that would fit.
 */
const bytesOf = (dtype: string) => (dtype.startsWith('F8_') ? 1 : (DTYPE_BYTES[dtype] ?? 1))

/** Σ parameters × bytes per dtype, or null when the listing carries no parameters. */
export function estimateWeightBytes(parameters: Record<string, number> | undefined): number | null {
  const entries = Object.entries(parameters ?? {})
  if (entries.length === 0) return null
  return entries.reduce((total, [dtype, count]) => total + count * bytesOf(dtype), 0)
}

export interface TensorrtPrefilterContext {
  /** The descriptor's `supported_architectures`; null when it could not be read. */
  supportedArchitectures: readonly string[] | null
  /** The cards of this machine, from the core's environment snapshot. */
  gpus: readonly GpuFacts[]
}

export function passesTensorrtPrefilter(model: CatalogModel, context: TensorrtPrefilterContext): boolean {
  const architectures = model.tensorrt?.architectures ?? []
  // Without `config.json` there is nothing the engine could load.
  if (architectures.length === 0) return false
  const { supportedArchitectures, gpus } = context
  if (supportedArchitectures && !architectures.some((name) => supportedArchitectures.includes(name))) {
    return false
  }
  const weights = estimateWeightBytes(model.tensorrt?.parameters)
  // A card with shared memory reports no VRAM, and the host's memory is not in the snapshot: the
  // size is left to the core's check rather than guessed against.
  if (weights === null || gpus.length === 0 || gpus.some((gpu) => gpu.total_vram_bytes === null)) {
    return true
  }
  const largest = Math.max(...gpus.map((gpu) => gpu.total_vram_bytes as number))
  return weights <= largest
}
