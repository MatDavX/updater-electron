import { describe, it, expect } from "bun:test";
import { dashboardRoutes } from "./dashboard";
import { GitHubCache } from "../github";
import { Storage } from "../storage";

describe("dashboardRoutes", () => {
  it("serve HTML com a seção Frota", async () => {
    const github = new GitHubCache();
    github.getLatest = async () => null;
    const app = dashboardRoutes(github, new Storage());
    const res = await app.handle(new Request("http://localhost/"));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('id="fleet-table"');
    expect(html).toContain("Frota");
    expect(html).toContain("loadFleet()");

    // Não pode reconstruir handlers de clique da frota via onclick com dados
    // interpoláveis do servidor (heartbeat é endpoint público) — isso permite
    // XSS armazenado, já que esc() escapa para contexto de texto/atributo
    // HTML, não para dentro de uma string JS. Os cliques devem usar
    // delegação de evento lendo data-* (esc() é seguro para atributo puro).
    expect(html).not.toContain('onclick="forceTerminal(');
    expect(html).not.toContain('onclick="unforceTerminal(');
    expect(html).not.toContain('onclick="removeTerminal(');
    expect(html).toContain('data-action="force"');

    // Mesmo problema para o botão "Deletar" da tabela de arquivos locais
    // (server-side, dados vêm do nome do arquivo em disco) — precisa usar
    // delegação de evento com data-filename, não onclick com string
    // interpolada pelo servidor.
    expect(html).not.toContain('onclick="deleteFile(');
  });
});
