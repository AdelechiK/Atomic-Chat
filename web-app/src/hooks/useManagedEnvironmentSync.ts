import { useEffect } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import { readManagedSnapshot } from '@/services/managed-environment/client'
import { startManagedEnvironmentSync } from '@/services/managed-environment/sync'

/**
 * Follows the core's managed-runtime state for the whole session (`startManagedEnvironmentSync`).
 * Linux only: the core has no managed environment anywhere else in this release.
 */
export function useManagedEnvironmentSync(): void {
  const serviceHub = useServiceHub()

  useEffect(() => {
    if (!IS_LINUX) return
    let stop: (() => void) | undefined
    let cancelled = false
    void startManagedEnvironmentSync({
      listen: (name, handler) => serviceHub.events().listen(name, handler),
      readSnapshot: readManagedSnapshot,
    })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else stop = unlisten
      })
      .catch((error) => console.warn('Managed environment events unavailable:', error))
    return () => {
      cancelled = true
      stop?.()
    }
  }, [serviceHub])
}
