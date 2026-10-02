import { useCallback, useEffect } from 'react'
import { create } from 'zustand'

import { descriptorHint, probe } from '@/services/managed-environment/client'
import type { EnvironmentSnapshot, RequirementPlan } from '@/services/managed-environment/types'
import { selectEnvironment, useManagedEnvironmentStore } from '@/stores/managed-environment-store'

/**
 * The core's plan for setting TensorRT-LLM up on this machine (`probe(descriptorHint(env))`), shared
 * by every screen that reads it — the provider page's setup and the Model Hub's TensorRT-LLM format
 * (change `add-tensorrt-llm-model-hub`, design D2) — so the two never disagree.
 *
 * One probe per revision of the core's environment snapshot: a new revision (the engine installed,
 * the WSL distribution gone, a new core) asks again, and so does `recheck()`. Probing changes
 * nothing on the machine. Module state, not component state: a screen opened later reads the plan
 * already held instead of asking again — except the provider page, which asks on every opening
 * (`enabled: false` and its own `recheck()`), as before. A failed probe holds no revision.
 */

interface PlanState {
  /** The snapshot the held plan answers (`instance:revision`, `none` before any snapshot). */
  key: string | null
  plan: RequirementPlan | undefined
  error: string | null
  probing: boolean
}

const EMPTY: PlanState = { key: null, plan: undefined, error: null, probing: false }

const usePlanStore = create<PlanState>()(() => EMPTY)

/** The request in flight; a newer one supersedes it, and its late answer is dropped. */
let inflight: { key: string; sequence: number; promise: Promise<RequirementPlan | undefined> } | null =
  null
let sequence = 0

export function resetTensorrtPlanForTests(): void {
  inflight = null
  sequence = 0
  usePlanStore.setState(EMPTY)
}

const errorText = (error: unknown) =>
  error && typeof error === 'object' && 'message' in error
    ? String((error as { message: unknown }).message)
    : String(error)

function snapshotKey(environment: EnvironmentSnapshot | undefined): string {
  return environment ? `${environment.instance_id}:${environment.revision}` : 'none'
}

function request(key: string, environment: EnvironmentSnapshot | undefined) {
  const mine = ++sequence
  usePlanStore.setState({ key, probing: true, error: null })
  const promise = probe(descriptorHint(environment)).then(
    (plan) => {
      if (inflight?.sequence !== mine) return plan
      inflight = null
      usePlanStore.setState({ plan, probing: false, error: null })
      return plan
    },
    (error) => {
      if (inflight?.sequence !== mine) return undefined
      inflight = null
      // A failure answers nothing about this revision: the next screen asks again.
      usePlanStore.setState({ key: null, probing: false, error: errorText(error) })
      return undefined
    }
  )
  inflight = { key, sequence: mine, promise }
  return promise
}

export interface TensorrtPlan {
  /** Undefined until the first answer; the last answer stays while a newer one is asked. */
  plan: RequirementPlan | undefined
  probing: boolean
  /** Why the last probe failed, or null. */
  error: string | null
  /** Ask the core again now; resolves to the new plan, undefined when the probe failed. */
  recheck: () => Promise<RequirementPlan | undefined>
}

/** `enabled: false` asks nothing (for a screen where the provider is hidden) and reads what is held. */
export function useTensorrtPlan({ enabled = true }: { enabled?: boolean } = {}): TensorrtPlan {
  const environment = useManagedEnvironmentStore(selectEnvironment)
  const key = snapshotKey(environment)
  const plan = usePlanStore((state) => state.plan)
  const probing = usePlanStore((state) => state.probing)
  const error = usePlanStore((state) => state.error)

  useEffect(() => {
    if (!enabled) return
    if (usePlanStore.getState().key === key || inflight?.key === key) return
    void request(key, selectEnvironment(useManagedEnvironmentStore.getState()))
  }, [enabled, key])

  const recheck = useCallback(() => {
    const current = selectEnvironment(useManagedEnvironmentStore.getState())
    return request(snapshotKey(current), current)
  }, [])

  return { plan, probing, error, recheck }
}
