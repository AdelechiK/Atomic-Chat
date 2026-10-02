import { useNavigate } from '@tanstack/react-router'
import type { RefObject } from 'react'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { TensorrtModelDownloadAction } from '@/containers/TensorrtModelDownloadAction'
import { TensorrtVerdict } from '@/containers/hub/TensorrtVerdict'
import { useTensorrtHubState } from '@/hooks/useTensorrtHubState'
import { useTensorrtVerdict } from '@/hooks/useTensorrtVerdict'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { HUB_FORMAT_LABELS } from '@/lib/hub-filters'
import type { CatalogModel } from '@/services/models/types'
import { TENSORRT_LLM_ENGINE_ID } from '@/stores/managed-environment-store'

/**
 * The download part of a TensorRT-LLM card (spec `tensorrt-llm-desktop`, "Выбор и скачивание
 * модели"): the core's verdict with its numbers, then what the person can do — download where the
 * engine is installed and the model runs here, install the engine first where it is not (design
 * D7: until then models have nowhere to go on Windows).
 */
export function TensorrtDownloadOptions({
  model,
  sectionRef,
}: {
  model: CatalogModel
  sectionRef?: RefObject<HTMLElement | null>
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { state } = useTensorrtHubState()
  const { verdict, checking } = useTensorrtVerdict(model)

  return (
    <section ref={sectionRef} className="scroll-mt-4 rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <span className="self-start rounded-[5px] border border-border px-1.5 py-px text-[10px] font-bold tracking-wider text-muted-foreground">
            {HUB_FORMAT_LABELS['tensorrt-llm']}
          </span>
          {checking ? (
            <p className="text-sm text-muted-foreground">{t('hub:tensorrt.models.checking')}</p>
          ) : (
            verdict && <TensorrtVerdict verdict={verdict} />
          )}
        </div>
        {state === 'not-installed' && (
          <Button
            size="sm"
            className="shrink-0"
            onClick={() =>
              navigate({
                to: route.settings.providers,
                params: { providerName: TENSORRT_LLM_ENGINE_ID },
              })
            }
          >
            {t('hub:tensorrt.installEngine')}
          </Button>
        )}
        {state === 'ready' && verdict?.kind === 'ok' && (
          <TensorrtModelDownloadAction model={model} revision={verdict.meta.revision} />
        )}
      </div>
    </section>
  )
}
