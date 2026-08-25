// Emergência GLOBAL (minVersion para toda a frota). Persistida no StateStore.
// Forçados por terminal ficam em state.forced (ver fleet.ts).
import { stateStore } from "./state-store";

export function getMinVersion(): string | null {
  return stateStore.get().minVersion;
}

export function setMinVersion(version: string | null): void {
  stateStore.update((s) => { s.minVersion = version; });
  if (version) {
    console.log(`[emergency] minVersion definido para v${version}`);
  } else {
    console.log(`[emergency] emergência limpa (minVersion null)`);
  }
}
