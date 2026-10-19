import type { RemoteAccessStatus } from "../../shared/remote-access";
import { useI18n } from "../lib/i18n";
import { HostConnections } from "./HostConnections";
import { RemoteAccessSettings } from "./RemoteAccessSettings";

interface RemoteConnectionsProps {
  status: RemoteAccessStatus;
  onChanged: (status: RemoteAccessStatus) => void;
  defaultHost?: string;
  defaultPort?: number;
  accessCode?: string;
  onManageDevices?: () => void;
}

/** One destination for saved outbound connections and this computer's sharing options. */
export function RemoteConnections(props: RemoteConnectionsProps) {
  const { t } = useI18n();
  return (
    <div class="space-y-7" data-testid="remote-connections">
      <header>
        <h1 class="text-xl font-semibold tracking-tight text-[var(--cm-text)]">{t().connectionCenter.title}</h1>
        <p class="mt-2 max-w-xl text-sm leading-relaxed text-[var(--cm-text-muted)]">{t().connectionCenter.description}</p>
      </header>
      <HostConnections />
      <div class="border-t border-[var(--cm-hairline)] pt-6">
        <RemoteAccessSettings
          status={props.status}
          onChanged={props.onChanged}
          defaultHost={props.defaultHost}
          defaultPort={props.defaultPort}
          accessCode={props.accessCode}
          onManageDevices={props.onManageDevices}
        />
      </div>
    </div>
  );
}
