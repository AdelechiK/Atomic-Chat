import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import {
  makeCatalog,
  makeFilesFor,
  MODELS_ROOT,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  diffusionDownloadTaskId,
  listInstalledArtifacts,
} from '@/lib/diffusion/models'
import type { DiffusionCatalogFamily } from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import {
  DEFAULT_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectSameWidth,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { MediaFamilyDetailPanel } from './MediaFamilyDetailPanel'

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }))
vi.mock('@/hooks/useHardwareTier', () => ({
  useHardwareTier: () => ({
    tier: 'vram_8',
    ready: true,
    profile: {
      tier: 'vram_8',
      memoryKind: 'vram',
      budgetMib: 16 * 1024,
      systemRamMib: 32 * 1024,
      vramMib: 16 * 1024,
      hardCeiling: false,
    },
  }),
}))

// Worst-case copy: a long name, a two-digit GB size, the longest quant label
// the catalog carries, one quant in each state.
const FAMILY: DiffusionCatalogFamily = {
  ...Z_IMAGE,
  name: 'Z-Image Turbo Extended Edition With A Very Long Family Name',
  description:
    'Fast 6B text-to-image model; 8 steps, no negative prompt. Ships with a 2.4 GB GGUF text encoder.',
  license: 'apache-2.0',
  transformer: {
    ...Z_IMAGE.transformer,
    quants: [
      ...Z_IMAGE.transformer.quants,
      {
        id: 'ud_q4_k_xl',
        label: 'UD_Q4_K_XL',
        filename: 'z-image-turbo-UD-Q4_K_XL.gguf',
        bytes: 12_300_000_000,
      },
    ],
  },
}

const INSTALLED = 'z-image:q4_k_m'
const DOWNLOADING = 'z-image:q8_0'

/** The Hub's right column: the window less the sidebar and the 420 px list. */
const panelWidth = (windowWidth: number) => windowWidth - 256 - 420

function seed() {
  const files = makeFilesFor(Z_IMAGE, 'q4_k_m')
  useImageGenerationStore.getState().reset()
  useImageGenerationStore.setState({
    catalog: makeCatalog([FAMILY]),
    modelFiles: files,
    installedArtifacts: listInstalledArtifacts(makeCatalog([FAMILY]), files),
    paths: {
      dataFolder: '/data',
      modelsRoot: MODELS_ROOT,
      backendsRoot: '/data/diffusion/backends',
      imagesDir: '/data/images',
      videosDir: '/data/videos',
    },
  })
  const taskId = diffusionDownloadTaskId(DOWNLOADING)
  useDownloadStore.setState({
    downloads: {
      [taskId]: {
        id: taskId,
        name: DOWNLOADING,
        progress: 1,
        current: 10_800_000_000,
        total: 10_800_000_000,
      },
    },
  })
}

for (const font of [DEFAULT_FONT_SIZE, XL_FONT_SIZE]) {
  for (const windowWidth of [1024, 1280]) {
    describe(`${font} ${windowWidth}px window`, () => {
      beforeEach(() => {
        setFontSize(font)
        setTheme('light')
        seed()
      })

      it('keeps Open, progress and Download in one column inside the panel', async () => {
        render(
          withTranslations(
            <div
              data-testid="panel-frame"
              style={{ width: panelWidth(windowWidth) }}
            >
              <MediaFamilyDetailPanel family={FAMILY} />
            </div>
          )
        )
        await act(async () => {
          await settle()
        })

        expectNoHorizontalOverflow(screen.getByTestId('panel-frame'))

        const rows = FAMILY.transformer.quants.map((quant) =>
          screen.getByTestId(`media-quant-z-image:${quant.id}`)
        )
        const actions = rows.map(
          (row) =>
            row.querySelector<HTMLElement>(
              '[data-testid="media-quant-actions"]'
            )!
        )
        // One state per row: Open, 100 %, Download.
        expect(actions.map((group) => group.textContent)).toEqual([
          'Open',
          '100%',
          'Download',
        ])
        expectSameWidth(actions)
        // The longest label is shown whole, and every chip is as wide as it.
        const labels = rows.map((row) => row.querySelector('.font-mono')!)
        expectSameWidth(labels)
        const longest = labels[2] as HTMLElement
        expect(longest.scrollWidth).toBeLessThanOrEqual(longest.clientWidth)
        expectSameWidth(
          actions.map((group) => group.querySelector('[data-slot="button"]')!)
        )
        const rights = actions.map(
          (group) => group.getBoundingClientRect().right
        )
        for (const right of rights) expect(right).toBeCloseTo(rights[0], 0)
        // Every row wraps the same way, so the actions stay one column.
        const offsets = rows.map(
          (row, index) =>
            actions[index].getBoundingClientRect().top -
            row.getBoundingClientRect().top
        )
        for (const offset of offsets) expect(offset).toBeCloseTo(offsets[0], 0)
      })
    })
  }
}
