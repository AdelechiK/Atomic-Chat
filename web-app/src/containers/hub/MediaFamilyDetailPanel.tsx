import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconExternalLink, IconTrash } from '@tabler/icons-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ModelLogo } from '@/containers/ModelLogo'
import { FitBadge } from '@/containers/hub/FitBadge'
import { ImageArtifactDownloadButton } from '@/containers/images/ImageArtifactDownloadButton'
import { route } from '@/constants/routes'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useSelectedArtifact } from '@/hooks/useVideoSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { recommendedQuant } from '@/lib/diffusion/fit'
import { artifactId } from '@/lib/diffusion/models'
import { workflowsForFamily } from '@/lib/diffusion/workflows'
import { formatBytes } from '@/lib/downloadFormat'
import { DIFFUSION_FAMILY_ICON_KEYS } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type {
  DiffusionCatalogFamily,
  DiffusionCatalogQuant,
} from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'

const gb = (bytes: number) => formatBytes(bytes, 1024 ** 3)

export type MediaFamilyDetailPanelProps = {
  family: DiffusionCatalogFamily | null
  className?: string
}

/**
 * The right-hand panel for an image or video family: every quant with its fit
 * and size, a download per quant, and — once one is on disk — the way into the
 * studio that runs it. The same `useImageArtifact` state as the Images and
 * Video model lists, so progress and removals agree with those pages.
 */
export function MediaFamilyDetailPanel({
  family,
  className,
}: MediaFamilyDetailPanelProps) {
  const { t } = useTranslation()
  const { profile } = useHardwareTier()

  if (!family) {
    return (
      <div
        className={cn(
          'flex h-full items-center justify-center p-6 text-sm text-muted-foreground',
          className
        )}
      >
        {t('hub:selectModel')}
      </div>
    )
  }

  const repo = family.transformer.repo
  const recommendedId = recommendedQuant(family, profile, {
    teOnCpu: IS_MACOS,
  })?.id
  const workflows =
    family.modality === 'image' ? workflowsForFamily(family.id) : []
  // Every label chip as wide as the family's longest, so `UD_Q3_K_XL` and
  // `UD_Q4_K_XL` stay told apart and the fit badges still line up.
  const labelWidth = `max(62px, calc(${Math.max(
    ...family.transformer.quants.map((quant) => quant.label.length)
  )}ch + 0.75rem))`

  return (
    <div className={cn('flex flex-col gap-4 p-6', className)}>
      <header className="flex items-start gap-3">
        <ModelLogo
          icon={DIFFUSION_FAMILY_ICON_KEYS[family.id]}
          name={family.name}
          author={family.developer}
        />
        <div className="min-w-0 flex-1">
          <h1
            className="min-w-0 truncate text-xl font-semibold"
            title={family.name}
          >
            {family.name}
          </h1>
          <p className="truncate text-xs text-muted-foreground">{repo}</p>
        </div>
        <a
          href={`https://huggingface.co/${repo}`}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0"
        >
          <Button variant="outline" size="sm" className="gap-1.5">
            <IconExternalLink size={14} />
            {t('hub:openOnWeb')}
          </Button>
        </a>
      </header>

      {family.description && (
        <p className="text-sm text-muted-foreground">{family.description}</p>
      )}

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-2 text-sm font-medium">{t('hub:downloadOptions')}</h2>
        <ul className="divide-y divide-border">
          {family.transformer.quants.map((quant) => (
            <MediaQuantRow
              key={quant.id}
              family={family}
              quant={quant}
              recommended={quant.id === recommendedId}
              labelWidth={labelWidth}
            />
          ))}
        </ul>
      </section>

      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:details')}</h2>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <DetailCell label={t('hub:defaultSize')}>
            {family.defaults.width}×{family.defaults.height}
          </DetailCell>
          <DetailCell label={t('hub:steps')}>
            {family.defaults.steps}
          </DetailCell>
          <DetailCell label={t('hub:license')}>
            {family.license ?? '—'}
          </DetailCell>
          {family.video ? (
            <DetailCell label={t('hub:frameRate')}>
              {family.video.fps} fps
            </DetailCell>
          ) : (
            <div className="rounded-md bg-muted/40 p-3">
              <dt className="text-muted-foreground">{t('hub:capabilities')}</dt>
              <dd className="mt-1.5 flex flex-wrap gap-1.5">
                {workflows.map((workflow) => (
                  <span
                    key={workflow}
                    className="rounded-[5px] bg-secondary px-1.5 py-px text-[10px] font-semibold text-muted-foreground"
                  >
                    {t(`images:workflow.${workflow}.label`)}
                  </span>
                ))}
              </dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  )
}

function DetailCell({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-md bg-muted/40 p-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-semibold text-foreground">
        {children}
      </dd>
    </div>
  )
}

function MediaQuantRow({
  family,
  quant,
  recommended,
  labelWidth,
}: {
  family: DiffusionCatalogFamily
  quant: DiffusionCatalogQuant
  recommended: boolean
  /** Shared by every row of the family: a CSS width for the label chip. */
  labelWidth: string
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const id = artifactId(family.id, quant.id)
  const artifact = useImageArtifact(id)
  const { setSelectedArtifactId } = useSelectedArtifact(family.modality)
  const generating = useImageGenerationStore((state) => state.generating)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [removing, setRemoving] = useState(false)

  const ready = artifact.complete && !artifact.downloading
  const openLabel =
    family.modality === 'video' ? t('hub:openInVideo') : t('hub:openInImages')

  // Picking the checkpoint here is what makes the studio open on it, the
  // same selection a download from the studio's own list records.
  const download = () => {
    setSelectedArtifactId(id)
    void artifact.download()
  }

  const openInStudio = () => {
    setSelectedArtifactId(id)
    void navigate({
      to: family.modality === 'video' ? route.videos.index : route.images.index,
    })
  }

  const remove = async () => {
    setRemoving(true)
    try {
      await artifact.remove()
      setConfirmRemove(false)
    } catch (error) {
      toast.error(t('images:model.removeFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setRemoving(false)
    }
  }

  return (
    <li
      // At 1024 px the panel is too narrow for the facts and the actions on
      // one line; every row then wraps the same way, actions under the facts.
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 py-2"
      data-testid={`media-quant-${id}`}
    >
      <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
        <span
          className="shrink-0 truncate rounded-[5px] bg-secondary px-1.5 py-0.5 text-center font-mono text-[11px] font-semibold text-muted-foreground"
          style={{ width: labelWidth }}
        >
          {quant.label}
        </span>
        <FitBadge
          fit={artifact.fit}
          className="shrink-0 px-2 py-0.5 text-[10px]"
        />
        <span className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground">
          {t('images:model.sizeGb', { size: gb(artifact.totalBytes) })}
        </span>
        {recommended && (
          <span className="min-w-0 truncate rounded-[5px] border border-border px-1.5 py-px text-[10px] font-semibold text-muted-foreground">
            {t('images:model.recommended')}
          </span>
        )}
      </span>
      {/* One action column in every state: Download, its progress and Open
          share the w-24 slot, and the remove slot is held even when empty. */}
      <span
        className="ml-auto flex shrink-0 items-center gap-1"
        data-testid="media-quant-actions"
      >
        {ready ? (
          <Button
            variant="outline"
            size="sm"
            className="w-24 justify-center"
            aria-label={openLabel}
            title={openLabel}
            onClick={openInStudio}
          >
            {t('hub:open')}
          </Button>
        ) : (
          <ImageArtifactDownloadButton
            artifact={artifact}
            variant="primary"
            className="w-24 justify-center"
            onRequestDownload={download}
          />
        )}
        {/* A half-downloaded quant is removable too: its files take disk
            space whether or not the download is ever finished. */}
        {artifact.installed && !artifact.downloading ? (
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-7"
            disabled={generating}
            aria-label={t('images:model.remove')}
            onClick={() => setConfirmRemove(true)}
          >
            <IconTrash size={15} className="text-muted-foreground" />
          </Button>
        ) : (
          <span className="size-7" aria-hidden />
        )}
      </span>

      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('images:model.removeTitle', {
                name: family.name,
                quant: quant.label,
              })}
            </DialogTitle>
            <DialogDescription>
              {t('images:model.removeDescription')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRemove(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={removing}
              onClick={() => void remove()}
            >
              {t('images:model.remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  )
}
