import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/shallow'

import { parseSeedText } from '@/hooks/useImageForm'
import { useVideoEstimate } from '@/hooks/useVideoEstimate'
import { useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import type {
  VideoEstimate,
  VideoGenerateRequest,
  VideoJob,
} from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'

/** Why Generate is disabled, as a `videos:form.disabled.<reason>` key. */
export type VideoGenerateDisabledReason =
  | 'noEngine'
  | 'noModel'
  | 'modelLoading'
  | 'emptyPrompt'
  | 'busy'

/** What `ConfirmVideoExceedsMemory` renders from. */
export type VideoExceedsConfirmation = {
  open: boolean
  /** Kept through the closing animation so the figures do not blank out. */
  estimate: VideoEstimate | null
  onCancel: () => void
  onConfirm: () => void
}

type PendingLaunch = {
  estimate: VideoEstimate
  request: VideoGenerateRequest
  seed: number | null
}

export type VideoGenerationHandle = {
  generating: boolean
  job: VideoJob | null
  stopRequested: boolean
  /** The resident model is this page's video model and its capabilities are known. */
  modelReady: boolean
  canGenerate: boolean
  disabledReason: VideoGenerateDisabledReason | null
  /** The request the form would submit right now. */
  request: VideoGenerateRequest
  seed: number | null
  /** The core's estimate of the draft; null while there is none. */
  estimate: VideoEstimate | null
  /** Asked before a draft whose estimate exceeds memory starts. */
  confirmation: VideoExceedsConfirmation
  generate: () => Promise<void>
  stop: () => Promise<void>
}

/**
 * Bridges the persisted Video form and the video job store: builds the
 * request, decides whether Generate is allowed (and why not), keeps the
 * core's estimate of the draft, and forwards the two verbs. Busy means
 * either page is generating: the two share one engine session.
 *
 * A draft the core says exceeds memory is not started straight away: the
 * `confirmation` asks first, Cancel is its default answer, and "Generate
 * anyway" starts exactly the draft that was asked about.
 */
export function useVideoGeneration(): VideoGenerationHandle {
  const form = useVideoForm(
    useShallow((state) => ({
      prompt: state.prompt,
      negativePrompt: state.negativePrompt,
      width: state.width,
      height: state.height,
      frames: state.frames,
      steps: state.steps,
      cfgScale: state.cfgScale,
      guidance: state.guidance,
      seedText: state.seedText,
    }))
  )
  const selectedArtifactId = useVideoSetting(
    (state) => state.selectedArtifactId
  )
  const { status, capabilities, loadingArtifactId, imageGenerating } =
    useImageGenerationStore(
      useShallow((state) => ({
        status: state.status,
        capabilities: state.videoCapabilities,
        loadingArtifactId: state.loadingArtifactId,
        imageGenerating: state.generating,
      }))
    )
  const { currentJob, stopRequested, generating, startGeneration, stop } =
    useVideoGenerationStore(
      useShallow((state) => ({
        currentJob: state.currentJob,
        stopRequested: state.stopRequested,
        generating: state.generating,
        startGeneration: state.startGeneration,
        stop: state.stop,
      }))
    )

  const engineInstalled = status?.install.state === 'installed'
  const loaded = status?.model.loaded ?? null
  const modelReady =
    status?.model.state === 'loaded' &&
    loaded?.modality === 'video' &&
    capabilities !== null &&
    (selectedArtifactId === null || loaded.modelId === selectedArtifactId)

  const seed = parseSeedText(form.seedText)

  const request = useMemo<VideoGenerateRequest>(() => {
    const trimmedNegative = form.negativePrompt.trim()
    return {
      prompt: form.prompt.trim(),
      ...(capabilities?.supportsNegativePrompt && trimmedNegative
        ? { negativePrompt: trimmedNegative }
        : {}),
      width: form.width,
      height: form.height,
      frames: form.frames,
      ...(capabilities ? { fps: capabilities.fps } : {}),
      steps: form.steps,
      cfgScale: form.cfgScale,
      ...(capabilities?.supportsGuidance && form.guidance !== null
        ? { guidance: form.guidance }
        : {}),
      ...(capabilities?.defaults.samplingMethod
        ? { samplingMethod: capabilities.defaults.samplingMethod }
        : {}),
      ...(capabilities?.defaults.flowShift !== undefined
        ? { flowShift: capabilities.defaults.flowShift }
        : {}),
      workflow: 'create',
    }
  }, [form, capabilities])

  const estimates = useVideoEstimate(
    request,
    modelReady ? (loaded?.modelId ?? null) : null
  )
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pending, setPending] = useState<PendingLaunch | null>(null)

  const disabledReason: VideoGenerateDisabledReason | null =
    generating || imageGenerating
      ? 'busy'
      : !engineInstalled
        ? 'noEngine'
        : loadingArtifactId
          ? 'modelLoading'
          : !modelReady
            ? 'noModel'
            : request.prompt.length === 0
              ? 'emptyPrompt'
              : null

  const { current } = estimates
  const generate = useCallback(async () => {
    if (disabledReason) return
    const estimate = await current()
    if (estimate?.memory.verdict === 'exceeds') {
      setPending({ estimate, request, seed })
      setConfirmOpen(true)
      return
    }
    await startGeneration({ request, seed })
  }, [disabledReason, current, startGeneration, request, seed])

  const onCancel = useCallback(() => setConfirmOpen(false), [])
  const onConfirm = useCallback(() => {
    setConfirmOpen(false)
    if (pending)
      void startGeneration({ request: pending.request, seed: pending.seed })
  }, [pending, startGeneration])

  return {
    generating,
    job: currentJob,
    stopRequested,
    modelReady,
    canGenerate: disabledReason === null,
    disabledReason,
    request,
    seed,
    estimate: estimates.estimate,
    confirmation: {
      open: confirmOpen,
      estimate: pending?.estimate ?? null,
      onCancel,
      onConfirm,
    },
    generate,
    stop,
  }
}
