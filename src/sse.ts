type SSEClient = (message: string) => void;

interface Subscription {
  send: SSEClient;
  terminalId: string | null;
}

export class SSEBroker {
  private subs = new Set<Subscription>();

  subscribe(client: SSEClient, meta?: { terminalId?: string }): () => void {
    const sub: Subscription = { send: client, terminalId: meta?.terminalId ?? null };
    this.subs.add(sub);
    console.log(`[sse] Client connected${sub.terminalId ? ` (${sub.terminalId})` : ""} (${this.subs.size} total)`);
    return () => {
      this.subs.delete(sub);
      console.log(`[sse] Client disconnected (${this.subs.size} total)`);
    };
  }

  private format(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  private deliver(sub: Subscription, message: string): boolean {
    try {
      sub.send(message);
      return true;
    } catch {
      this.subs.delete(sub);
      return false;
    }
  }

  broadcast(event: string, data: unknown, opts?: { exclude?: (terminalId: string | null) => boolean }): void {
    const message = this.format(event, data);
    let n = 0;
    for (const sub of [...this.subs]) {
      if (opts?.exclude?.(sub.terminalId)) continue;
      if (this.deliver(sub, message)) n++;
    }
    console.log(`[sse] Broadcast "${event}" to ${n} clients`);
  }

  /** Envia só para as conexões daquele terminal. Retorna quantas receberam. */
  sendTo(terminalId: string, event: string, data: unknown): number {
    const message = this.format(event, data);
    let n = 0;
    for (const sub of [...this.subs]) {
      if (sub.terminalId !== terminalId) continue;
      if (this.deliver(sub, message)) n++;
    }
    console.log(`[sse] "${event}" → ${terminalId}: ${n} conexão(ões)`);
    return n;
  }

  isConnected(terminalId: string): boolean {
    for (const sub of this.subs) if (sub.terminalId === terminalId) return true;
    return false;
  }

  connectedTerminalIds(): string[] {
    const ids = new Set<string>();
    for (const sub of this.subs) if (sub.terminalId) ids.add(sub.terminalId);
    return [...ids];
  }

  get count(): number {
    return this.subs.size;
  }
}

export const sseBroker = new SSEBroker();
