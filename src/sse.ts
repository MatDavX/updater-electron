type SSEClient = (message: string) => void;

class SSEBroker {
  private clients = new Set<SSEClient>();

  subscribe(client: SSEClient): () => void {
    this.clients.add(client);
    console.log(`[sse] Client connected (${this.clients.size} total)`);
    return () => {
      this.clients.delete(client);
      console.log(`[sse] Client disconnected (${this.clients.size} total)`);
    };
  }

  broadcast(event: string, data: unknown): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of this.clients) {
      try {
        client(message);
      } catch {
        this.clients.delete(client);
      }
    }
    console.log(`[sse] Broadcast "${event}" to ${this.clients.size} clients`);
  }

  get count(): number {
    return this.clients.size;
  }
}

export const sseBroker = new SSEBroker();
