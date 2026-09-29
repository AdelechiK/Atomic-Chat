import { useLanAccess } from '@/hooks/useLanAccess'
import {
  type LocalApiServerControl,
  useRemoteAccess,
} from '@/hooks/useRemoteAccess'

import { LanAccessCard } from './LanAccessCard'
import { RemoteAccessCard } from './RemoteAccessCard'

/**
 * Remote access and LAN access on the API screen.
 *
 * `server` is the screen's own control, shared with its Start/Stop button:
 * each control re-checks the server on focus and owns a "loading model" flag,
 * and everything that starts or stops the server must agree on both.
 */
export function RemoteLanSection({
  server,
}: {
  server: LocalApiServerControl
}) {
  const remote = useRemoteAccess({ server })
  const lan = useLanAccess({ server, hasApiKey: remote.hasApiKey })

  return (
    <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
      <RemoteAccessCard remote={remote} />
      <LanAccessCard lan={lan} />
    </div>
  )
}
