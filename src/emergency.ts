// Estado in-memory da atualização OBRIGATÓRIA (emergência).
// minVersion: versão mínima suportada. Clientes abaixo dela travam até atualizar.
// Servido publicamente em /min-version.json e broadcastado via SSE (event: emergency).

let minVersion: string | null = null;

export function getMinVersion(): string | null {
  return minVersion;
}

export function setMinVersion(version: string | null): void {
  minVersion = version;
  if (version) {
    console.log(`[emergency] minVersion definido para v${version}`);
  } else {
    console.log(`[emergency] emergência limpa (minVersion null)`);
  }
}
