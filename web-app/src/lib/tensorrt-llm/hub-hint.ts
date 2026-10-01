/**
 * The Model Hub's "Models for TensorRT-LLM" hint (spec `tensorrt-llm-desktop`, "Подсказка в Model
 * Hub"; task 3.16). The Hub does not list TensorRT-LLM models itself; the hint sends the person to
 * the provider page — to its model picker once the engine is installed, otherwise to the install.
 */

import type {
  EnvironmentSnapshot,
  RuntimeInstallation,
} from '@/services/managed-environment/types'

export type HubHint =
  /** The engine is installed: the provider page's model picker. */
  | 'choose-model'
  /** Not installed yet (or mid-install, or a failed install): the provider page's install. */
  | 'install'
  /** Something on the machine has to change first; the provider page lists what. */
  | 'blocked'

/**
 * `null` — no hint — when the provider is hidden (no NVIDIA card, macOS or Windows on ARM, no
 * descriptor or no Windows environment manifest: the extension's own answer, R-app-5) or before
 * the core's snapshot is in, when nothing true can be said yet. The snapshot exists on Linux and
 * Windows only, so no platform check is needed on top.
 */
export function hubHint(options: {
  providerShown: boolean
  environment: EnvironmentSnapshot | undefined
  installation: RuntimeInstallation | undefined
}): HubHint | null {
  const { providerShown, environment, installation } = options
  if (!providerShown || !environment) return null
  if (installation?.status === 'ready') return 'choose-model'
  const availability = installation?.availability ?? environment.availability
  return availability === 'prerequisite-blocked' ? 'blocked' : 'install'
}
