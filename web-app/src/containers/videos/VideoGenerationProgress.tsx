import { memo, useEffect, useState } from 'react'
import { IconAlertTriangle } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { durationUnits, remainingSeconds } from '@/lib/video/estimate'
import { formatDuration } from '@/lib/video/format-duration'
import type { VideoJob } from '@/services/diffusion/types'

type VideoGenerationProgressProps = {
  job: VideoJob | null
  /** The page's clock origin for the clip, used until the core reports. */
  startedAtMs: number
}

/**
 * The bar and the time left under the live preview of a clip: the core's
 * whole-job fraction and ETA, "Finishing the clip…" while the decode runs
 * past its forecast. The step and the elapsed time are the placeholder's.
 */
export const VideoGenerationProgress = memo(function VideoGenerationProgress({
  job,
  startedAtMs,
}: VideoGenerationProgressProps) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  if (!job) return null
  const progress = job.progress
  const remaining = remainingSeconds(job, now, startedAtMs)
  const decoding =
    progress?.phase === 'decoding' || progress?.phase === 'postprocessing'
  const text =
    remaining !== null
      ? t('videos:progress.remaining', {
          duration: formatDuration(remaining, durationUnits(t)),
        })
      : decoding
        ? t('videos:progress.finishing')
        : null

  return (
    <div
      className="mx-auto w-full max-w-md shrink-0 space-y-1 px-6 pb-4"
      data-testid="video-job-progress"
    >
      <Progress
        aria-label={t('images:progress.label')}
        value={Math.round((progress?.fraction ?? 0) * 100)}
        className="h-1 bg-muted"
      />
      {text && (
        <p
          className="truncate text-center text-[11px] leading-4 tabular-nums text-muted-foreground"
          aria-live="polite"
          data-testid="video-job-remaining"
        >
          {text}
        </p>
      )}
    </div>
  )
})

type VideoSlowdownWarningProps = {
  /** The user already pressed Stop: the cancel is on its way. */
  stopping: boolean
  onStop: () => void
}

/**
 * The core saw the steps slow down sharply, the sign of a machine swapping:
 * say so, say what helps, and offer to stop the clip.
 */
export function VideoSlowdownWarning({
  stopping,
  onStop,
}: VideoSlowdownWarningProps) {
  const { t } = useTranslation()
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
      data-testid="video-slowdown"
    >
      <IconAlertTriangle
        size={16}
        className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="text-sm font-medium">
          {t('videos:progress.slowdown.title')}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('videos:progress.slowdown.body')}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="shrink-0"
        disabled={stopping}
        onClick={onStop}
      >
        {t('videos:progress.slowdown.stop')}
      </Button>
    </div>
  )
}

export default VideoGenerationProgress
