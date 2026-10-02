import { describe, expect, it } from 'vitest'

import { estimateWeightBytes, passesTensorrtPrefilter } from '../hub-feed'
import type { GpuFacts } from '@/services/managed-environment/types'
import type { CatalogModel } from '@/services/models/types'

const GB = 1e9

const card = (total: number | null, id = 'GPU-1'): GpuFacts => ({
  gpu_id: id,
  name: 'RTX 4090',
  compute_capability: '8.9',
  total_vram_bytes: total,
  free_vram_bytes: total,
  driver_version: '615.65.02',
})

const entry = (tensorrt: CatalogModel['tensorrt']): CatalogModel => ({
  model_name: 'owner/model',
  description: '',
  downloads: 0,
  is_tensorrt_llm: true,
  tensorrt,
})

const supported = ['Qwen3ForCausalLM', 'Qwen3_5ForConditionalGeneration']

describe('estimateWeightBytes', () => {
  it('counts each dtype at its width: F32/I32 4, BF16/F16 2, F8_*/U8/I8 1', () => {
    expect(
      estimateWeightBytes({ F32: 1, I32: 1, BF16: 1, F16: 1, F8_E4M3: 1, F8_E5M2: 1, U8: 1, I8: 1 })
    ).toBe(4 + 4 + 2 + 2 + 1 + 1 + 1 + 1)
    // NVFP4: the U8 count is already packed bytes.
    expect(estimateWeightBytes({ U8: 9 * GB, F8_E4M3: 1.1 * GB, BF16: 2 * GB })).toBe(14.1 * GB)
  })

  it('knows nothing without parameters, and counts an unknown dtype at its narrowest', () => {
    expect(estimateWeightBytes(undefined)).toBeNull()
    expect(estimateWeightBytes({})).toBeNull()
    expect(estimateWeightBytes({ F4: 10 })).toBe(10)
  })
})

describe('passesTensorrtPrefilter', () => {
  it.each([
    {
      name: 'a supported architecture that fits the card',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 8 * GB } }),
      gpus: [card(24 * GB)],
      kept: true,
    },
    {
      name: 'an architecture the descriptor does not support',
      model: entry({ architectures: ['MambaForCausalLM'], parameters: { BF16: 1 * GB } }),
      gpus: [card(24 * GB)],
      kept: false,
    },
    {
      name: '140 GB of weights against a 24 GB card',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 70 * GB } }),
      gpus: [card(24 * GB)],
      kept: false,
    },
    {
      name: 'too big for one card, fits the bigger one',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 14 * GB } }),
      gpus: [card(12 * GB), card(32 * GB, 'GPU-2')],
      kept: true,
    },
    {
      name: 'a card with shared memory (no VRAM figure): size is not judged',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 70 * GB } }),
      gpus: [card(24 * GB), card(null, 'GB10')],
      kept: true,
    },
    {
      name: 'no config in the listing',
      model: entry({ parameters: { BF16: 1 * GB } }),
      gpus: [card(24 * GB)],
      kept: false,
    },
    {
      name: 'no parameters in the listing: size unknown, not judged',
      model: entry({ architectures: ['Qwen3_5ForConditionalGeneration'] }),
      gpus: [card(24 * GB)],
      kept: true,
    },
    {
      name: 'no cards known yet: size is not judged',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 70 * GB } }),
      gpus: [],
      kept: true,
    },
  ])('$name', ({ model, gpus, kept }) => {
    expect(passesTensorrtPrefilter(model, { supportedArchitectures: supported, gpus })).toBe(kept)
  })

  it('without the descriptor architectures, judges only what it knows', () => {
    const model = entry({ architectures: ['MambaForCausalLM'], parameters: { BF16: 1 * GB } })
    expect(passesTensorrtPrefilter(model, { supportedArchitectures: null, gpus: [card(24 * GB)] })).toBe(
      true
    )
    expect(
      passesTensorrtPrefilter(entry({}), { supportedArchitectures: null, gpus: [card(24 * GB)] })
    ).toBe(false)
  })
})
