import { memo } from 'react'
import { IconAlertTriangle, IconClock } from '@tabler/icons-react'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { durationUnits, exceedsSentence } from '@/lib/video/estimate'
import { formatDurationRange } from '@/lib/video/format-duration'
import type { VideoEstimate } from '@/services/diffusion/types'

type VideoEstimateLineProps = {
  estimate: VideoEstimate | null
  className?: string
}

/**
 * The core's estimate of the draft under Generate: a range of time when the
 * clip fits, a warning tone when memory is tight, and when it exceeds memory
 * what it needs against what there is, that it will swap for hours, and what
 * to change. Nothing at all without an estimate (an older core, no model).
 */
export const VideoEstimateLine = memo(function VideoEstimateLine({
  estimate,
  className,
}: VideoEstimateLineProps) {
  const { t } = useTranslation()
  if (!estimate) return null
  const { verdict } = estimate.memory

  if (verdict === 'exceeds') {
    return (
      <div
        role="status"
        className={cn(
          'flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs',
          className
        )}
        data-testid="video-estimate"
        data-verdict={verdict}
      >
        <IconAlertTriangle
          size={14}
          className="mt-px shrink-0 text-destructive"
        />
        <div className="min-w-0 space-y-0.5">
          <p className="font-medium text-destructive">
            {exceedsSentence(estimate, t)}
          </p>
          <p className="text-muted-foreground">
            {t('videos:estimate.exceedsSwap')}{' '}
            {t('videos:estimate.exceedsAdvice')}
          </p>
        </div>
      </div>
    )
  }

  const range = estimate.seconds
    ? formatDurationRange(
        estimate.seconds.low,
        estimate.seconds.high,
        durationUnits(t)
      )
    : null
  return (
    <p
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1 text-xs',
        verdict === 'tight'
          ? 'text-amber-600 dark:text-amber-400'
          : 'text-muted-foreground',
        className
      )}
      data-testid="video-estimate"
      data-verdict={verdict}
    >
      <IconClock size={13} className="shrink-0" />
      {range && (
        <span className="tabular-nums">
          {t('videos:estimate.duration', { range })}
        </span>
      )}
      {verdict === 'tight' && (
        <span>
          {range ? '· ' : ''}
          {t('videos:estimate.tight')}
        </span>
      )}
      {estimate.basis === 'history' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="cursor-help underline decoration-dotted underline-offset-2"
              data-testid="video-estimate-history"
            >
              {t('videos:estimate.historyShort')}
            </span>
          </TooltipTrigger>
          <TooltipContent>{t('videos:estimate.history')}</TooltipContent>
        </Tooltip>
      )}
    </p>
  )
})

export default VideoEstimateLine
