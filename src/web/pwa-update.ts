/** A worker activated by another tab must never reload this page without consent. */
export function createPwaUpdateGate(canReload: () => boolean, reload: () => void) {
  let requested = false;
  let activated = false;

  return {
    request(): boolean {
      if (!canReload()) return false;
      if (activated) reload();
      else requested = true;
      return true;
    },
    activate(): void {
      activated = true;
      const permitted = requested && canReload();
      requested = false;
      if (permitted) reload();
    },
    cancel(): void { requested = false; },
  };
}
