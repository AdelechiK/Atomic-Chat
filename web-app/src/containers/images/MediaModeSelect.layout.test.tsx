import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_IMAGE_FORM, useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { DEFAULT_VIDEO_FORM, useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import {
  makeCapabilities,
  makeCatalog,
  makeFakeDiffusion,
  makeFilesFor,
  makeLoadedStatus,
  MODELS_ROOT,
  Q4_ID,
  Z_IMAGE,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  LTX_2,
  LTX_Q4_ID,
  makeVideoCapabilities,
  makeVideoLoadedStatus,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { listInstalledArtifacts } from '@/lib/diffusion/models'
import {
  DEFAULT_FONT_SIZE,
  expectFits,
  expectNoHorizontalOverflow,
  expectOneLine,
  settle,
  setFontSize,
  setTheme,
  withTranslations,
  XL_FONT_SIZE,
} from '@/test/layout'
import { seedServiceHub } from '@/test/service-hub'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { VideoPromptForm } from '@/containers/videos/VideoPromptForm'
import { ImagePromptForm } from './ImagePromptForm'

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  Link: ({
    to,
    children,
    ...props
  }: { to: string; children: React.ReactNode } &
    React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
}))
vi.mock('@/containers/chatInput/useTauriDragDrop', () => ({
  useTauriDragDrop: () => undefined,
}))
vi.mock('@/lib/notifications', () => ({ notifyWhenAway: vi.fn() }))
vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: vi.fn() }))
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

const PATHS = {
  dataFolder: '/data',
  modelsRoot: MODELS_ROOT,
  backendsRoot: '/data/diffusion/backends',
  imagesDir: '/data/images',
  videosDir: '/data/videos',
}

async function seed() {
  localStorage.clear()
  await useImageForm.persist.rehydrate()
  await useImageSetting.persist.rehydrate()
  await useVideoForm.persist.rehydrate()
  await useVideoSetting.persist.rehydrate()
  useImageForm.setState({ ...DEFAULT_IMAGE_FORM, prompt: 'A lighthouse' })
  useImageSetting.setState({ selectedArtifactId: Q4_ID, advancedOpen: false })
  useVideoForm.setState({ ...DEFAULT_VIDEO_FORM, prompt: 'A lighthouse' })
  useVideoSetting.setState({
    selectedArtifactId: LTX_Q4_ID,
    advancedOpen: false,
  })
  useImageGenerationStore.getState().reset()
  useVideoGenerationStore.getState().reset()
  seedServiceHub({ diffusion: makeFakeDiffusion() })
}

function seedImage() {
  const catalog = makeCatalog()
  const files = makeFilesFor(Z_IMAGE, 'q4_k_m')
  useImageGenerationStore.setState({
    catalog,
    modelFiles: files,
    installedArtifacts: listInstalledArtifacts(catalog, files),
    status: makeLoadedStatus(Q4_ID),
    capabilities: makeCapabilities(),
    paths: PATHS,
  })
}

function seedVideo() {
  const catalog = makeCatalog([Z_IMAGE, LTX_2])
  const files = makeFilesFor(LTX_2, 'q4_k_m')
  useImageGenerationStore.setState({
    catalog,
    modelFiles: files,
    installedArtifacts: listInstalledArtifacts(catalog, files),
    status: makeVideoLoadedStatus(),
    videoCapabilities: makeVideoCapabilities(),
    paths: PATHS,
  })
}

const PAGES = [
  {
    name: 'Images',
    prefix: 'image',
    seed: seedImage,
    Form: ImagePromptForm,
    options: 7,
  },
  {
    name: 'Video',
    prefix: 'video',
    seed: seedVideo,
    Form: VideoPromptForm,
    options: 2,
  },
] as const

describe('media page heading and mode pill geometry', () => {
  beforeEach(async () => {
    await seed()
  })

  for (const pageSpec of PAGES) {
    it.each([
      { fontSize: DEFAULT_FONT_SIZE, theme: 'light' as const, width: 1280 },
      { fontSize: XL_FONT_SIZE, theme: 'dark' as const, width: 1024 },
    ])(
      `${pageSpec.name}: the heading, the mode pill and its open list fit the 340 px column at $fontSize/$theme`,
      async ({ fontSize, theme, width }) => {
        await page.viewport(width, 900)
        setFontSize(fontSize)
        setTheme(theme)
        pageSpec.seed()
        const { Form, prefix } = pageSpec
        render(
          withTranslations(
            // The page's aside: a column the form stretches across.
            <div
              className="flex h-[860px] w-[340px] min-w-0 flex-col overflow-hidden"
              data-testid="form-frame"
            >
              <Form />
            </div>
          )
        )
        await act(async () => {
          await settle()
        })

        const frame = screen.getByTestId('form-frame')
        // The page heading is one line, beside the Reset button; the subtitle
        // wraps inside the column rather than running under Reset.
        const heading = screen.getByTestId(`${prefix}-page-title`)
        const subtitle = screen.getByTestId(`${prefix}-page-subtitle`)
        const reset = screen.getByRole('button', { name: 'Reset' })
        expectOneLine(heading)
        expectFits(heading, frame)
        expectFits(subtitle, frame)
        expect(heading.getBoundingClientRect().right).toBeLessThan(
          reset.getBoundingClientRect().left
        )
        expect(subtitle.getBoundingClientRect().right).toBeLessThan(
          reset.getBoundingClientRect().left
        )
        expect(subtitle.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          heading.getBoundingClientRect().bottom
        )
        // The mode pill is its own row under them, as wide as the column's
        // content, and its truncating title is tall enough not to clip a "g".
        const select = screen.getByTestId(`${prefix}-workflow-select`)
        const title = screen.getByTestId(`${prefix}-workflow-title`)
        const scroller = screen.getByTestId(`${prefix}-form-scroller`)
        const content = scroller.getBoundingClientRect()
        const padding = getComputedStyle(scroller)
        expect(select.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          subtitle.getBoundingClientRect().bottom
        )
        expect(select.getBoundingClientRect().left).toBeCloseTo(
          content.left + Number.parseFloat(padding.paddingLeft),
          0
        )
        expect(select.getBoundingClientRect().right).toBeCloseTo(
          reset.getBoundingClientRect().right,
          0
        )
        expectOneLine(title)
        expect(title.scrollHeight).toBeLessThanOrEqual(title.clientHeight)
        expectFits(select, frame)
        expectNoHorizontalOverflow(frame)

        await userEvent.click(select)
        await act(async () => {
          await settle()
          await settle()
        })

        const menu = screen.getByTestId(`${prefix}-workflow-menu`)
        const options = within(menu).getAllByRole('menuitem')
        expect(options).toHaveLength(pageSpec.options)
        expectFits(menu, document.documentElement)
        expectNoHorizontalOverflow(menu)
        for (const option of options) {
          expectFits(option, menu)
          const label = option.querySelector('.truncate') as HTMLElement
          expectOneLine(label)
          expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth)
        }
        // The list opens under the pill, starting at its left edge.
        expect(menu.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          select.getBoundingClientRect().bottom
        )
        expect(menu.getBoundingClientRect().left).toBeCloseTo(
          select.getBoundingClientRect().left,
          0
        )
      }
    )
  }
})
