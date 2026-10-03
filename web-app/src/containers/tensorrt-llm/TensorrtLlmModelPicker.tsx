import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/utils'
import type {
  CuratedModel,
  GpuFacts,
  ModelCompatibility,
} from '@/services/managed-environment/types'
import {
  checkRequestFor,
  checkTensorrtModel,
  describeDescriptor,
  fetchHfRevision,
  GatedModelError,
  IncompatibleModelError,
  installTensorrtModel,
  InsufficientModelSpaceError,
  normalizeRepository,
  type HfRevision,
} from '@/services/tensorrt-llm/models'
import {
  selectEnvironment,
  selectTensorrtInstallation,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * Choosing and downloading a TensorRT-LLM model (spec `tensorrt-llm-desktop`, "Выбор и скачивание
 * модели"): the installed engine's curated models that fit this machine, and any Hugging Face
 * repository pasted in. Every choice is read at a pinned revision and checked by the core before a
 * single weight is downloaded.
 */

/** One empty list for every render without an environment: a fresh `[]` would re-render forever. */
const NO_GPUS: GpuFacts[] = []

type Verdict =
  | { kind: 'ok'; meta: HfRevision; compatibility: ModelCompatibility }
  | { kind: 'incompatible'; compatibility: ModelCompatibility }
  | { kind: 'gated'; url: string }
  /** The core has less room where models go than the download needs (on Windows: the guest). */
  | { kind: 'no-space'; root: string; neededBytes: number; freeBytes: number }
  | { kind: 'error'; message: string }

const errorText = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)

async function evaluate(repository: string, revision: string | undefined, token: string | undefined): Promise<Verdict> {
  try {
    const meta = await fetchHfRevision(repository, revision, token)
    const compatibility = await checkTensorrtModel(checkRequestFor(meta))
    return compatibility.verdict.ok
      ? { kind: 'ok', meta, compatibility }
      : { kind: 'incompatible', compatibility }
  } catch (error) {
    if (error instanceof GatedModelError) return { kind: 'gated', url: error.url }
    return { kind: 'error', message: errorText(error) }
  }
}

export function TensorrtLlmModelPicker({ onInstalled }: { onInstalled: () => Promise<void> }) {
  const { t } = useTranslation()
  const token = useGeneralSetting((state) => state.huggingfaceToken) || undefined
  const installation = useManagedEnvironmentStore(selectTensorrtInstallation)
  const gpus = useManagedEnvironmentStore((state) => selectEnvironment(state)?.gpus ?? NO_GPUS)
  const descriptorId = installation?.active_descriptor_id ?? null

  const [input, setInput] = useState('')
  const [checking, setChecking] = useState(false)
  const [verdict, setVerdict] = useState<Verdict | null>(null)
  const [curated, setCurated] = useState<Array<{ model: CuratedModel; verdict: Verdict }>>([])
  const [download, setDownload] = useState<{ repository: string; done: number; total: number } | null>(null)
  const [downloadError, setDownloadError] = useState<Verdict | null>(null)

  // The curated models of the installed engine, each checked against this machine's cards.
  useEffect(() => {
    if (!descriptorId) return
    let cancelled = false
    void (async () => {
      const summary = await describeDescriptor(descriptorId)
      if (!summary || cancelled) return
      // Side by side: each is a few small reads from Hugging Face and one network-free core check.
      const checked = await Promise.all(
        summary.curated_models.map(async (model) => ({
          model,
          verdict: await evaluate(model.repository, model.revision, token),
        }))
      )
      if (cancelled) return
      setCurated(checked.filter((entry) => entry.verdict.kind === 'ok'))
    })()
    return () => {
      cancelled = true
    }
  }, [descriptorId, token])

  const check = async () => {
    const repository = normalizeRepository(input)
    if (!repository.includes('/')) return
    setChecking(true)
    setVerdict(null)
    setDownloadError(null)
    setVerdict(await evaluate(repository, undefined, token))
    setChecking(false)
  }

  const install = async (repository: string, revision: string) => {
    setDownloadError(null)
    setDownload({ repository, done: 0, total: 0 })
    try {
      await installTensorrtModel({
        repository,
        revision,
        token,
        onProgress: (done, total) => setDownload({ repository, done, total }),
      })
      setDownload(null)
      await onInstalled()
    } catch (error) {
      setDownload(null)
      if (error instanceof IncompatibleModelError) {
        setDownloadError({ kind: 'incompatible', compatibility: error.compatibility })
      } else if (error instanceof GatedModelError) {
        setDownloadError({ kind: 'gated', url: error.url })
      } else if (error instanceof InsufficientModelSpaceError) {
        setDownloadError({
          kind: 'no-space',
          root: error.root,
          neededBytes: error.neededBytes,
          freeBytes: error.freeBytes,
        })
      } else {
        setDownloadError({ kind: 'error', message: errorText(error) })
      }
    }
  }

  const busy = download !== null

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-main-view-fg/10 p-4">
      <h2 className="font-medium text-main-view-fg">{t('providers:tensorrt.models.title')}</h2>

      {curated.length > 0 && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('providers:tensorrt.models.curated')}</p>
          <ul className="flex flex-col gap-2">
            {curated.map(({ model, verdict: fit }) => (
              <li key={model.repository} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm">{model.repository}</p>
                  {fit.kind === 'ok' && (
                    <p className="truncate text-xs tabular-nums text-main-view-fg/70">
                      {formatBytes(fit.compatibility.weight_bytes)}
                    </p>
                  )}
                  {fit.kind === 'ok' && <Warnings compatibility={fit.compatibility} />}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void install(model.repository, model.revision)}
                >
                  {t('providers:tensorrt.models.download')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t('providers:tensorrt.models.fromHub')}</p>
        <div className="flex items-center gap-2">
          <Input
            className="min-w-0"
            value={input}
            placeholder="nvidia/Qwen3-8B-FP8"
            onChange={(event) => setInput(event.target.value)}
          />
          <Button size="sm" disabled={checking || busy || !input.trim()} onClick={() => void check()}>
            {t('providers:tensorrt.models.check')}
          </Button>
        </div>
        {verdict && (
          <VerdictLine
            verdict={verdict}
            gpus={gpus}
            onDownload={
              verdict.kind === 'ok' && !busy
                ? () => void install(verdict.meta.repository, verdict.meta.revision)
                : undefined
            }
          />
        )}
      </div>

      {download && (
        <div className="flex flex-col gap-1">
          <p className="truncate text-sm">{t('providers:tensorrt.models.downloading', { repository: download.repository })}</p>
          {download.total > 0 && (
            <>
              <Progress value={Math.min(100, (download.done / download.total) * 100)} />
              <p className="truncate text-xs tabular-nums text-main-view-fg/70">
                {t('providers:tensorrt.progress', {
                  done: formatBytes(download.done),
                  total: formatBytes(download.total),
                })}
              </p>
            </>
          )}
        </div>
      )}
      {downloadError && <VerdictLine verdict={downloadError} gpus={gpus} />}
    </div>
  )
}

function VerdictLine({
  verdict,
  gpus,
  onDownload,
}: {
  verdict: Verdict
  gpus: GpuFacts[]
  onDownload?: () => void
}) {
  const { t } = useTranslation()
  switch (verdict.kind) {
    case 'ok':
      return (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-sm">
              {t('providers:tensorrt.models.fits', {
                size: formatBytes(verdict.compatibility.weight_bytes),
              })}
            </p>
            {onDownload && (
              <Button size="sm" onClick={onDownload}>
                {t('providers:tensorrt.models.download')}
              </Button>
            )}
          </div>
          <Warnings compatibility={verdict.compatibility} />
        </div>
      )
    case 'no-space':
      return (
        <p className="break-words text-sm text-destructive">
          {t('providers:tensorrt.models.noSpace', {
            path: verdict.root,
            needed: formatBytes(verdict.neededBytes),
            free: formatBytes(verdict.freeBytes),
          })}
        </p>
      )
    case 'incompatible': {
      const others = verdict.compatibility.fits_other_gpus
        .map((id) => gpus.find((gpu) => gpu.gpu_id === id)?.name ?? id)
        .join(', ')
      return (
        <div className="flex flex-col gap-1 text-sm">
          <p className="break-words text-destructive">
            {verdict.compatibility.verdict.ok ? '' : verdict.compatibility.verdict.error.message}
          </p>
          {others && <p className="break-words">{t('providers:tensorrt.models.otherCard', { cards: others })}</p>}
        </div>
      )
    }
    case 'gated':
      return (
        <a className="text-sm underline break-words" href={verdict.url} target="_blank" rel="noreferrer">
          {t('providers:tensorrt.models.gated', { url: verdict.url })}
        </a>
      )
    case 'error':
      return <p className="break-words text-sm text-destructive">{verdict.message}</p>
  }
}

/** The check's warnings, in the core's words: shown, never in the way of the download. */
function Warnings({ compatibility }: { compatibility: ModelCompatibility }) {
  const warnings = compatibility.warnings ?? []
  if (warnings.length === 0) return null
  return (
    <ul className="flex flex-col gap-1">
      {warnings.map((warning) => (
        <li key={warning.code} className="break-words text-xs text-amber-600">
          {warning.message}
        </li>
      ))}
    </ul>
  )
}
