import { resolveDiffusionDownloadTaskId } from '@/lib/diffusion/models'
import { downloadKind } from '@/lib/telemetry'
import type { DiffusionCatalog } from '@/services/diffusion-catalog-registry'

type Translate = (key: string, options?: Record<string, unknown>) => string

export type DownloadNotification = { title: string; body: string }

/**
 * What the OS notification says when a download from the panel finishes: a
 * model by its name, an engine by what it runs. `null` for a companion file
 * (the CUDA runtime), which only ever lands as part of an engine install.
 */
export function describeFinishedDownload(
  id: string,
  downloadType: string | undefined,
  catalog: DiffusionCatalog | null,
  t: Translate
): DownloadNotification | null {
  switch (downloadKind(id, downloadType)) {
    case 'companion_artifact':
      return null
    case 'gpu_backend':
      return {
        title: t('common:desktopNotification.engineReadyTitle'),
        body: t(
          id.startsWith('diffusion-backend')
            ? 'common:desktopNotification.mediaEngineReadyBody'
            : 'common:desktopNotification.chatEngineReadyBody'
        ),
      }
    case 'diffusion_model':
    case 'model':
      return {
        title: t('common:desktopNotification.modelReadyTitle'),
        body: t('common:desktopNotification.modelReadyBody', {
          name: modelName(id, catalog),
        }),
      }
  }
}

/** A diffusion task names its catalog family; other ids end in the file name. */
function modelName(id: string, catalog: DiffusionCatalog | null): string {
  const diffusion = catalog ? resolveDiffusionDownloadTaskId(catalog, id) : null
  if (diffusion) return diffusion.family.name
  return id.split('/').pop() || id
}
