import { useNavigate } from '@tanstack/react-router'

import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { hubHint } from '@/lib/tensorrt-llm/hub-hint'
import {
  selectEnvironment,
  selectTensorrtInstallation,
  TENSORRT_LLM_ENGINE_ID,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * "Models for TensorRT-LLM" in the Model Hub (task 3.16): the Hub cannot download these models, so
 * it points to the provider page, which picks and downloads them — or installs the engine first.
 */
export function TensorrtLlmHubHint() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const providerShown = useModelProvider((state) =>
    state.providers.some((provider) => provider.provider === TENSORRT_LLM_ENGINE_ID)
  )
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const installation = useManagedEnvironmentStore(selectTensorrtInstallation)
  const hint = hubHint({ providerShown, environment, installation })
  if (!hint) return null

  return (
    <div
      role="note"
      className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm"
    >
      <p className="font-medium">{t('hub:tensorrt.title')}</p>
      <p className="text-muted-foreground">{t(`hub:tensorrt.${hint}.body`)}</p>
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        onClick={() =>
          navigate({
            to: route.settings.providers,
            params: { providerName: TENSORRT_LLM_ENGINE_ID },
          })
        }
      >
        {t(`hub:tensorrt.${hint}.action`)}
      </Button>
    </div>
  )
}
