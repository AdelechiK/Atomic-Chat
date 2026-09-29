import { describe, expect, it } from 'vitest'

import i18n from '@/i18n/setup'
import { makeCatalog, Q4_ID } from '@/lib/diffusion/__tests__/image-fixtures'
import { diffusionDownloadTaskId } from '@/lib/diffusion/models'
import { describeFinishedDownload } from '../downloadNotification'

const t = i18n.t.bind(i18n) as (
  key: string,
  options?: Record<string, unknown>
) => string

describe('describeFinishedDownload', () => {
  it('names a chat model by the file it downloaded', () => {
    expect(
      describeFinishedDownload('bartowski/Kimi-K3-Q4_K_M', 'Model', null, t)
    ).toEqual({
      title: 'Model downloaded',
      body: 'Kimi-K3-Q4_K_M is ready to use.',
    })
  })

  it('names an image or video model by its catalog family', () => {
    expect(
      describeFinishedDownload(
        diffusionDownloadTaskId(Q4_ID),
        'Model',
        makeCatalog(),
        t
      )
    ).toEqual({
      title: 'Model downloaded',
      body: 'Z-Image Turbo is ready to use.',
    })
  })

  it('tells the llama.cpp engine from the image and video engine', () => {
    expect(
      describeFinishedDownload(
        'llamacpp-backend-b6500/macos-arm64',
        'Backend',
        null,
        t
      )
    ).toEqual({
      title: 'Engine installed',
      body: 'llama.cpp is ready to run models.',
    })
    expect(
      describeFinishedDownload(
        'diffusion-backend-master-849-d04e895-macos-arm64',
        'Backend',
        null,
        t
      )
    ).toEqual({
      title: 'Engine installed',
      body: 'The image and video engine is ready.',
    })
  })

  it('stays silent for the CUDA runtime that comes with an engine', () => {
    expect(
      describeFinishedDownload('cudart-llama-bin-win-cu12', 'Backend', null, t)
    ).toBeNull()
  })
})
