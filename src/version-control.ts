import { stateStore } from "./state-store";

export function getActiveVersion(): string | null {
  return stateStore.get().activeVersion;
}

export function setActiveVersion(version: string | null): void {
  stateStore.update((s) => { s.activeVersion = version; });
  if (version) {
    console.log(`[version] Active version pinned to v${version}`);
  } else {
    console.log(`[version] Active version reset to latest`);
  }
}
