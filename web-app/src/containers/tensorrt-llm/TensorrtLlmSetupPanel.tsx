import { useCallback, useEffect, useRef, useState } from 'react'
import { create } from 'zustand'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/utils'
import {
  deriveSetupView,
  planSummary,
  type BlockerView,
  type PlanSummary,
} from '@/lib/tensorrt-llm/setup-view'
import {
  beginOperation,
  cancelOperation,
  descriptorHint,
  probe,
  resumeOperation,
  runHostStep,
} from '@/services/managed-environment/client'
import { describeDescriptor } from '@/services/tensorrt-llm/models'
import type {
  EnvironmentOperation,
  RequirementPlan,
  Sha256Digest,
} from '@/services/managed-environment/types'
import {
  selectEnvironment,
  selectFailedSetup,
  selectSetupOperation,
  selectTensorrtInstallation,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'

/**
 * The TensorRT-LLM part of the provider page (Linux): whether this machine can run the engine and
 * why not, the whole plan before consent, the OS authorization prompt, the sign-in the Docker group
 * needs, the pull with its bytes, and removing the engine (spec `tensorrt-llm-desktop`).
 *
 * Everything shown comes from the core — its plan and its operation, which outlives this panel —
 * so closing the page and opening it again finds the same setup where it is.
 */

/** What the person agreed to, until the core asks for that consent. */
type Approval = { kind: 'setup'; digest: Sha256Digest } | { kind: 'remove' }

/**
 * Privileged steps already put to the OS prompt, and the ones whose prompt is still open. Module
 * state, not component state: leaving the provider page and opening it again must not raise a
 * second password prompt for a step whose executor may still be running.
 */
const promptedSteps = new Set<string>()
/** Steps whose prompt is open, as a store so every mounted panel sees it close. */
const useElevatingSteps = create<{ steps: string[] }>()(() => ({ steps: [] }))

export function resetHostStepPromptsForTests(): void {
  promptedSteps.clear()
  useElevatingSteps.setState({ steps: [] })
}

const errorText = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)

export function TensorrtLlmSetupPanel() {
  const { t } = useTranslation()
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const installation = useManagedEnvironmentStore(selectTensorrtInstallation)
  const operation = useManagedEnvironmentStore(selectSetupOperation)
  const failed = useManagedEnvironmentStore(selectFailedSetup)

  const [plan, setPlan] = useState<RequirementPlan>()
  const [probing, setProbing] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [planOpen, setPlanOpen] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [keepModels, setKeepModels] = useState(true)
  const [manualCommand, setManualCommand] = useState<string | null>(null)
  const [notices, setNotices] = useState<string[]>([])
  const approval = useRef<Approval | null>(null)
  const answeredConsent = useRef<string | null>(null)
  const elevatingSteps = useElevatingSteps((state) => state.steps)
  const environmentRef = useRef(environment)
  environmentRef.current = environment

  /** Ask the core again what setting up would take on this machine; probing changes nothing. */
  const recheck = useCallback(async () => {
    setProbing(true)
    setActionError(null)
    try {
      const next = await probe(descriptorHint(environmentRef.current))
      setPlan(next)
      return next
    } catch (error) {
      setActionError(errorText(error))
      return undefined
    } finally {
      setProbing(false)
    }
  }, [])

  useEffect(() => {
    void recheck()
  }, [recheck])

  // The NVIDIA notices of the descriptor this plan installs; when the core cannot serve that
  // descriptor, the plan says the notices were not reported.
  const planDescriptor = plan?.descriptor_id ?? null
  useEffect(() => {
    setNotices([])
    if (!planDescriptor) return
    let cancelled = false
    void describeDescriptor(planDescriptor).then((summary) => {
      if (!cancelled) setNotices(summary?.notices ?? [])
    })
    return () => {
      cancelled = true
    }
  }, [planDescriptor])

  const environmentId = environment?.environment_id ?? 'default'

  const act = async (run: () => Promise<unknown>) => {
    setActionError(null)
    try {
      await run()
    } catch (error) {
      setActionError(errorText(error))
    }
  }

  const agree = (shown: RequirementPlan) =>
    act(async () => {
      setPlanOpen(false)
      if (operation?.phase === 'awaiting-consent' && operation.plan_digest === shown.plan_digest) {
        // The core is already asking; answer it with the plan the person just read.
        answeredConsent.current = `${operation.operation_id}:${operation.revision}`
        await resumeOperation(operation.operation_id, operation.revision, shown.plan_digest)
        return
      }
      approval.current = { kind: 'setup', digest: shown.plan_digest }
      await beginOperation(environmentId, {
        request_id: crypto.randomUUID(),
        kind: 'setup',
        ...(shown.descriptor_id ? { descriptor_id: shown.descriptor_id } : {}),
      })
    })

  // The core asks for consent on every operation. Approve exactly what the person agreed to here;
  // anything else — the machine changed, or this window never showed a plan — is shown first.
  useEffect(() => {
    if (operation?.phase !== 'awaiting-consent' || !operation.plan_digest) return
    const asked = `${operation.operation_id}:${operation.revision}`
    if (answeredConsent.current === asked) return
    answeredConsent.current = asked
    const agreed = approval.current
    approval.current = null
    // A removal this window did not start (or started before it was reopened): ask with the
    // removal's own dialog; confirming it approves what the core offers.
    if (operation.kind === 'remove' && agreed?.kind !== 'remove') {
      setRemoveOpen(true)
      return
    }
    const approves =
      agreed?.kind === 'remove' ||
      (agreed?.kind === 'setup' && agreed.digest === operation.plan_digest)
    if (approves) {
      void act(() =>
        resumeOperation(operation.operation_id, operation.revision, operation.plan_digest as Sha256Digest)
      )
      return
    }
    void recheck().then((next) => {
      if (next) setPlanOpen(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation?.operation_id, operation?.phase, operation?.revision, operation?.plan_digest])

  // The privileged step: the OS prompt comes up once per step on its own; a retry is a button.
  const grant = useCallback((operationId: string, stepId: string) => {
    // One prompt at a time per step: a second executor would race the first over the package
    // manager, and its receipt would be refused.
    if (useElevatingSteps.getState().steps.includes(stepId)) return
    useElevatingSteps.setState(({ steps }) => ({ steps: [...steps, stepId] }))
    promptedSteps.add(stepId)
    setManualCommand(null)
    void runHostStep(operationId)
      .then((answer) => {
        if (answer.outcome === 'manual') setManualCommand(answer.command)
      })
      .catch((error) => setActionError(errorText(error)))
      .finally(() =>
        useElevatingSteps.setState(({ steps }) => ({
          steps: steps.filter((step) => step !== stepId),
        }))
      )
  }, [])

  useEffect(() => {
    const step = operation?.pending_host_step
    if (operation?.phase !== 'preparing-host' || !step) return
    if (promptedSteps.has(step.step_id)) return
    grant(operation.operation_id, step.step_id)
  }, [operation?.operation_id, operation?.phase, operation?.pending_host_step, grant])

  const view = deriveSetupView({ plan, operation, installation, failed })
  const summary = plan ? planSummary(plan, notices) : undefined

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-main-view-fg/10 p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-medium text-main-view-fg">{t('providers:tensorrt.title')}</h2>
          <p className="text-sm text-main-view-fg/70">{t('providers:tensorrt.description')}</p>
        </div>
      </div>

      {view.kind === 'checking' && (
        <p className="text-sm text-main-view-fg/70">{t('providers:tensorrt.checking')}</p>
      )}

      {view.kind === 'blocked' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('providers:tensorrt.blocked')}</p>
          <Blockers blockers={view.blockers} />
          {summary?.disk.insufficient && <DiskLine summary={summary} />}
          <div>
            <Button variant="outline" size="sm" disabled={probing} onClick={() => void recheck()}>
              {t('providers:tensorrt.checkAgain')}
            </Button>
          </div>
        </div>
      )}

      {view.kind === 'not-installed' && (
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 text-sm text-main-view-fg/70">
            {t('providers:tensorrt.notInstalled')}
          </p>
          <Button size="sm" disabled={probing} onClick={() => setPlanOpen(true)}>
            {t('providers:tensorrt.install')}
          </Button>
        </div>
      )}

      {view.kind === 'operation' && (
        <OperationStatus
          operation={view.operation}
          step={view.step}
          manualCommand={manualCommand}
          onCancel={() => void act(() => cancelOperation(view.operation.operation_id))}
          granting={elevatingSteps.includes(
            view.operation.pending_host_step?.step_id ?? ''
          )}
          onGrant={() =>
            view.operation.pending_host_step &&
            grant(view.operation.operation_id, view.operation.pending_host_step.step_id)
          }
          onReview={() => void recheck().then((next) => next && setPlanOpen(true))}
        />
      )}

      {view.kind === 'failed' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('providers:tensorrt.failed')}</p>
          <p className="text-sm text-destructive break-words">{view.operation.error?.message}</p>
          <div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                void act(() => resumeOperation(view.operation.operation_id, view.operation.revision))
              }
            >
              {t('providers:tensorrt.retry')}
            </Button>
          </div>
        </div>
      )}

      {view.kind === 'installed' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t('providers:tensorrt.installed')}</p>
          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 text-sm text-main-view-fg/70">
              {t('providers:tensorrt.remove.space', {
                size: formatBytes(plan?.required_disk_bytes ?? undefined),
              })}
            </p>
            <Button variant="outline" size="sm" onClick={() => setRemoveOpen(true)}>
              {t('providers:tensorrt.remove.button')}
            </Button>
          </div>
        </div>
      )}

      {actionError && <p className="text-sm text-destructive break-words">{actionError}</p>}

      <Dialog open={planOpen} onOpenChange={setPlanOpen}>
        <DialogContent className="max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('providers:tensorrt.plan.title')}</DialogTitle>
            <DialogDescription>{t('providers:tensorrt.plan.intro')}</DialogDescription>
          </DialogHeader>
          {plan && summary && <PlanDetails summary={summary} />}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPlanOpen(false)}>
              {t('providers:tensorrt.plan.cancel')}
            </Button>
            <Button disabled={!plan || !summary?.canStart} onClick={() => plan && void agree(plan)}>
              {t('providers:tensorrt.plan.agree')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('providers:tensorrt.remove.title')}</DialogTitle>
            <DialogDescription>{t('providers:tensorrt.remove.body')}</DialogDescription>
          </DialogHeader>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={keepModels}
              onChange={(event) => setKeepModels(event.target.checked)}
            />
            {t('providers:tensorrt.remove.keepModels')}
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveOpen(false)}>
              {t('providers:tensorrt.plan.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() =>
                void act(async () => {
                  setRemoveOpen(false)
                  if (
                    operation?.kind === 'remove' &&
                    operation.phase === 'awaiting-consent' &&
                    operation.plan_digest
                  ) {
                    // The core is already asking about this removal.
                    answeredConsent.current = `${operation.operation_id}:${operation.revision}`
                    await resumeOperation(
                      operation.operation_id,
                      operation.revision,
                      operation.plan_digest
                    )
                    return
                  }
                  approval.current = { kind: 'remove' }
                  await beginOperation(environmentId, {
                    request_id: crypto.randomUUID(),
                    kind: 'remove',
                    retain_models: keepModels,
                  })
                })
              }
            >
              {t('providers:tensorrt.remove.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function Blockers({ blockers }: { blockers: BlockerView[] }) {
  const { t } = useTranslation()
  return (
    <ul className="flex flex-col gap-2">
      {blockers.map((blocker, index) => (
        <li key={index} className="flex min-w-0 flex-col gap-1 text-sm">
          <span className="break-words">
            {blocker.ampere
              ? t('providers:tensorrt.blocker.ampere', blocker.ampere)
              : blocker.message}
          </span>
          {blocker.commands.length > 0 && (
            <pre className="select-all overflow-x-auto rounded bg-main-view-fg/5 p-2 text-xs">
              {blocker.commands.join('\n')}
            </pre>
          )}
        </li>
      ))}
    </ul>
  )
}

function DiskLine({ summary }: { summary: PlanSummary }) {
  const { t } = useTranslation()
  const { path, requiredBytes, freeBytes } = summary.disk
  const required = formatBytes(requiredBytes ?? undefined)
  if (path === null) {
    // The core measured nothing this time (the free-space read failed).
    return (
      <p className="text-sm break-words">
        {freeBytes !== null
          ? t('providers:tensorrt.plan.diskNoPath', { required, free: formatBytes(freeBytes) })
          : t('providers:tensorrt.plan.diskUnknown', { required })}
      </p>
    )
  }
  return (
    <p className="text-sm break-words">
      {freeBytes !== null
        ? t('providers:tensorrt.plan.disk', { path, required, free: formatBytes(freeBytes) })
        : t('providers:tensorrt.plan.diskNoFree', { path, required })}
    </p>
  )
}

function PlanDetails({ summary }: { summary: PlanSummary }) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-col gap-3 text-sm">
      {summary.changes.length > 0 ? (
        <ul className="flex list-disc flex-col gap-1 pl-5">
          {summary.changes.map((change, index) => (
            <li
              key={index}
              className={change.warning ? 'break-words font-medium text-amber-600' : 'break-words'}
            >
              {change.text}
            </li>
          ))}
        </ul>
      ) : (
        <p>{t('providers:tensorrt.plan.noSystemChanges')}</p>
      )}
      {summary.relogin && <p className="font-medium">{t('providers:tensorrt.plan.relogin')}</p>}
      {summary.downloadBytes !== null && (
        <p>
          {t('providers:tensorrt.plan.download', {
            size: formatBytes(summary.downloadBytes),
          })}
        </p>
      )}
      <DiskLine summary={summary} />
      {summary.notices.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="font-medium">{t('providers:tensorrt.plan.notices')}</p>
          {summary.notices.map((notice, index) => (
            <p key={index} className="break-words text-main-view-fg/70">
              {notice}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-main-view-fg/70">{t('providers:tensorrt.plan.noticesMissing')}</p>
      )}
      {summary.blockers.length > 0 && <Blockers blockers={summary.blockers} />}
    </div>
  )
}

function OperationStatus({
  operation,
  step,
  manualCommand,
  granting,
  onCancel,
  onGrant,
  onReview,
}: {
  operation: EnvironmentOperation
  step: 'consent' | 'host-step' | 'relogin' | 'working'
  manualCommand: string | null
  /** The OS prompt for this step is open; asking again would start a second executor. */
  granting: boolean
  onCancel: () => void
  onGrant: () => void
  onReview: () => void
}) {
  const { t } = useTranslation()
  const progress = operation.progress
  const bytes =
    progress?.unit === 'bytes' && progress.completed !== null && progress.total
      ? {
          done: formatBytes(progress.completed),
          total: formatBytes(progress.total),
          percent: Math.min(100, (progress.completed / progress.total) * 100),
        }
      : null

  return (
    <div className="flex flex-col gap-2">
      {step === 'relogin' ? (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t('providers:tensorrt.relogin.title')}</p>
          <p className="text-sm text-main-view-fg/70">{t('providers:tensorrt.relogin.body')}</p>
        </div>
      ) : (
        <p className="text-sm font-medium">{t(`providers:tensorrt.phase.${operation.phase}`)}</p>
      )}

      {bytes && (
        <div className="flex flex-col gap-1">
          <Progress value={bytes.percent} />
          <p className="truncate text-xs tabular-nums text-main-view-fg/70">
            {t('providers:tensorrt.progress', { done: bytes.done, total: bytes.total })}
          </p>
        </div>
      )}

      {step === 'host-step' && (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-main-view-fg/70">
            {manualCommand
              ? t('providers:tensorrt.hostStep.manual')
              : t('providers:tensorrt.hostStep.waiting')}
          </p>
          {manualCommand && (
            <pre className="select-all overflow-x-auto rounded bg-main-view-fg/5 p-2 text-xs">
              {manualCommand}
            </pre>
          )}
          <div>
            <Button variant="outline" size="sm" disabled={granting} onClick={onGrant}>
              {t('providers:tensorrt.hostStep.retry')}
            </Button>
          </div>
        </div>
      )}

      {step === 'consent' && (
        <div>
          <Button size="sm" onClick={onReview}>
            {t('providers:tensorrt.consent.review')}
          </Button>
        </div>
      )}

      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={operation.cancellation_requested || operation.phase === 'cancelling'}
          onClick={onCancel}
        >
          {t('providers:tensorrt.cancel')}
        </Button>
      </div>
    </div>
  )
}
