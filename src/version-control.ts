let activeVersion: string | null = null;

export function getActiveVersion(): string | null {
  return activeVersion;
}

export function setActiveVersion(version: string | null): void {
  activeVersion = version;
  if (version) {
    console.log(`[version] Active version pinned to v${version}`);
  } else {
    console.log(`[version] Active version reset to latest`);
  }
}
