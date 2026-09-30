import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { DropdownControl } from '@/containers/dynamicControllerSetting/DropdownControl'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/utils'
import type { GpuFacts, ManagedError } from '@/services/managed-environment/types'
import {
  selectEnvironment,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * The TensorRT-LLM settings the generic list cannot render well (spec `tensorrt-llm-desktop`,
 * "Настройки, логи и удаление"): the card, chosen from the GPUs the core found rather than typed
 * as a UUID, the output limit checked against the context, and each model's container log. The
 * context length, output limit, KV-cache share and load timeout stay in the generic list, from the
 * extension's `settings.json` (the core's schema). Changes apply from the next load.
 */

/** `GET /models/tensorrt-llm/:id/logs`. */
type ModelLogs =
  | { model_id: string; source: 'session'; generation: string; log_tail: string }
  | {
      model_id: string
      source: 'last-attempt'
      generation: string
      log_tail: string
      error: ManagedError | null
      at: number
    }
  | { model_id: string; source: null; log_tail: '' }

const NO_GPUS: GpuFacts[] = []

const valueOf = (settings: ProviderSetting[], key: string): unknown =>
  (settings.find((s) => s.key === key)?.controller_props as { value?: unknown } | undefined)?.value

function gpuLabel(gpu: GpuFacts): string {
  const memory =
    gpu.free_vram_bytes !== null && gpu.total_vram_bytes !== null
      ? ` · ${formatBytes(gpu.free_vram_bytes)} / ${formatBytes(gpu.total_vram_bytes)}`
      : ''
  return `${gpu.name} (${gpu.compute_capability})${memory}`
}

export function TensorrtLlmSettingsCard({
  settings,
  models,
  onChange,
}: {
  settings: ProviderSetting[]
  /** Downloaded model ids, whose logs can be read. */
  models: string[]
  onChange: (key: string, value: unknown) => void
}) {
  const { t } = useTranslation()
  const gpus = useManagedEnvironmentStore((state) => selectEnvironment(state)?.gpus ?? NO_GPUS)
  const gpuId = String(valueOf(settings, 'gpu_id') ?? '')
  const context = Number(valueOf(settings, 'context_length'))
  const output = Number(valueOf(settings, 'max_output_tokens'))
  const [logs, setLogs] = useState<{ model: string; logs?: ModelLogs; error?: string } | null>(null)

  const gpuGone = gpuId !== '' && !gpus.some((gpu) => gpu.gpu_id === gpuId)

  const showLogs = async (model: string) => {
    setLogs({ model })
    try {
      const answer = await invoke<ModelLogs>('atomic_core_call', {
        method: 'GET',
        path: `/models/tensorrt-llm/${model}/logs`,
        body: null,
      })
      setLogs({ model, logs: answer })
    } catch (error) {
      setLogs({ model, error: String((error as { message?: unknown })?.message ?? error) })
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-main-view-fg/10 p-4">
      <h2 className="font-medium text-main-view-fg">{t('providers:tensorrt.settings.title')}</h2>

      <div className="flex min-w-0 flex-col gap-1 text-sm">
        <span className="font-medium">{t('providers:tensorrt.settings.gpu')}</span>
        {/* The app's own menu, not a native <select>: WebKitGTK draws a select's list with the
            system theme, so in the app's dark theme it came up light (F-11). */}
        <DropdownControl
          value={gpuId}
          options={[
            { value: '', name: t('providers:tensorrt.settings.gpuDefault') },
            ...gpus.map((gpu) => ({ value: gpu.gpu_id, name: gpuLabel(gpu) })),
            ...(gpuGone ? [{ value: gpuId, name: gpuId }] : []),
          ]}
          onChange={(value) => onChange('gpu_id', String(value))}
        />
        {gpuGone && (
          <span className="text-xs text-main-view-fg/70">
            {t('providers:tensorrt.settings.gpuMissing', { gpu: gpuId })}
          </span>
        )}
      </div>

      {Number.isFinite(context) && Number.isFinite(output) && output >= context && (
        <p className="text-sm text-destructive">
          {t('providers:tensorrt.settings.outputTooLong', { output, context })}
        </p>
      )}

      {models.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('providers:tensorrt.settings.logs')}</p>
          <ul className="flex flex-col gap-1">
            {models.map((model) => (
              <li key={model} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm">{model}</span>
                <Button variant="outline" size="sm" onClick={() => void showLogs(model)}>
                  {t('providers:tensorrt.settings.viewLogs')}
                </Button>
              </li>
            ))}
          </ul>
          {logs && (
            <div className="flex min-w-0 flex-col gap-1">
              {logs.logs?.source === 'last-attempt' && logs.logs.error && (
                <p className="text-sm text-destructive break-words">{logs.logs.error.message}</p>
              )}
              {logs.error && <p className="text-sm text-destructive break-words">{logs.error}</p>}
              {logs.logs && (
                <pre className="max-h-80 overflow-auto rounded bg-main-view-fg/5 p-2 text-xs whitespace-pre-wrap break-words">
                  {logs.logs.log_tail || t('providers:tensorrt.settings.noLogs')}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
