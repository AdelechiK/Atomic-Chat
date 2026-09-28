import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { VideoExceedsConfirmation } from '@/hooks/useVideoGeneration'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { exceedsSentence } from '@/lib/video/estimate'

/**
 * "This clip does not fit in memory" — asked when Generate is pressed on a
 * draft the core's estimate says exceeds memory, and only then;
 * `useVideoGeneration` decides when. Cancel is the default answer: it holds
 * the focus, and Enter, Escape, the close button and a click outside all
 * start nothing. Only "Generate anyway" starts the clip, with the draft
 * that was asked about (ADR 2026-09-17's download dialog, applied to a run).
 */
export function ConfirmVideoExceedsMemory({
  open,
  estimate,
  onCancel,
  onConfirm,
}: VideoExceedsConfirmation) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent data-testid="video-exceeds-dialog">
        <DialogHeader>
          <DialogTitle>{t('videos:confirmExceeds.title')}</DialogTitle>
          <DialogDescription>
            {estimate ? exceedsSentence(estimate, t) : null}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('videos:confirmExceeds.body')}
        </p>
        <DialogFooter>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto"
              autoFocus
            >
              {t('common:cancel')}
            </Button>
          </DialogClose>
          <Button size="sm" className="w-full sm:w-auto" onClick={onConfirm}>
            {t('videos:confirmExceeds.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ConfirmVideoExceedsMemory
