# Electron Update Server

Servidor leve de atualizações para aplicações Electron construídas com **Electron Forge + electron-updater**. Consulta a API do GitHub para descobrir novas versões e serve os binários armazenados localmente.

Inspirado no [Hazel](https://github.com/vercel/hazel), porém com armazenamento local dos binários.

## Como funciona

```
┌──────────────┐        ┌──────────────────┐        ┌──────────────┐
│  GitHub API  │──meta──▶  Update Server   │◀─req───│  Electron    │
│  (releases)  │        │  (Elysia + Bun)  │──yml──▶│  App Client  │
└──────────────┘        │                  │──bin──▶│              │
                        │  ./releases/     │        └──────────────┘
                        │  (binários)      │
                        └──────────────────┘
```

1. O servidor consulta `GET /repos/:owner/:repo/releases/latest` no GitHub (com cache de 15 min)
2. Quando o app Electron pede `latest.yml`, o servidor gera o YAML com a versão do GitHub + metadados (sha512, size) dos binários locais
3. O `electron-updater` no client compara versões e baixa o binário se houver atualização

## Requisitos

- [Bun](https://bun.sh) >= 1.0

## Instalação

```bash
git clone <repo-url>
cd updater-electron
bun install
```

## Configuração

Copie o arquivo de exemplo e preencha com seus dados:

```bash
cp .env.example .env
```

| Variável | Obrigatória | Descrição |
|----------|:-----------:|-----------|
| `GITHUB_ACCOUNT` | Sim | Owner do repositório (ex: `MatDavX`) |
| `GITHUB_REPO` | Sim | Nome do repositório (ex: `papaya-pdv`) |
| `GITHUB_TOKEN` | Não* | Personal access token do GitHub |
| `RELEASES_DIR` | Não | Diretório dos binários (padrão: `./releases`) |
| `PORT` | Não | Porta do servidor (padrão: `3000`) |
| `CACHE_TTL` | Não | Tempo de cache em ms (padrão: `900000` = 15 min) |
| `DATA_DIR` | Não | Diretório do estado persistente (emergência, pin, frota). Padrão: ./data |
| `API_SECRET` | Não | Token dos endpoints admin (`Authorization: Bearer <API_SECRET>`). Se vazio, `/api/*` e `/refresh` ficam ABERTOS (modo dev) |
| `WEB_API_SECRET` | Não | Token de escopo reduzido para o papaya-web (frota, versão fixada, emergência, status e histórico). Não sobe nem apaga binário nem cria release (403). Deve ser diferente de `API_SECRET` |

\* Obrigatório se o repositório for privado. Gere em: GitHub > Settings > Developer settings > Personal access tokens > Fine-grained tokens (permissão `Contents: read`).

## Executando

```bash
# Desenvolvimento (hot reload)
bun run dev

# Produção
bun run start
```

## Rotas da API

### Rotas de atualização (electron-updater)

| Rota | Descrição |
|------|-----------|
| `GET /latest.yml` | Metadados de atualização para **Windows** |
| `GET /latest-mac.yml` | Metadados de atualização para **macOS** |
| `GET /latest-linux.yml` | Metadados de atualização para **Linux** |

Estas rotas retornam YAML no formato que o `electron-updater` espera:

```yaml
version: 1.0.0
files:
  - url: papaya-pdv-Setup-1.0.0.exe
    sha512: <hash-base64>
    size: 96296728
path: papaya-pdv-Setup-1.0.0.exe
sha512: <hash-base64>
releaseDate: "2024-09-18T12:29:53.000Z"
```

### Rotas de download

| Rota | Descrição |
|------|-----------|
| `GET /download/:filename` | Baixa um binário específico |
| `GET /download/latest/:platform` | Redireciona para o binário mais recente da plataforma |

**Exemplos:**

```bash
# Baixar um arquivo específico
curl -O http://localhost:3000/download/papaya-pdv-Setup-1.0.0.exe

# Redirecionar para o mais recente por plataforma (win32, darwin, linux)
curl -L http://localhost:3000/download/latest/win32
curl -L http://localhost:3000/download/latest/darwin
curl -L http://localhost:3000/download/latest/linux
```

`GET /download/:filename` suporta `Range` (retorna `206 Partial Content`) tanto para arquivos locais quanto via proxy do GitHub.

### Rotas de administração

| Rota | Método | Auth | Descrição |
|------|--------|:----:|-----------|
| `/health` | `GET` | não | Status do servidor, versão cached e quantidade de arquivos locais |
| `/refresh` | `POST` | sim | Força refresh do cache do GitHub e limpa cache de metadados dos arquivos |

**Exemplos:**

```bash
# Verificar status do servidor
curl http://localhost:3000/health
# Resposta:
# {
#   "status": "ok",
#   "latestVersion": "1.0.0",
#   "releaseDate": "2026-03-05T13:04:45Z",
#   "localFiles": 3
# }

# Forçar refresh do cache
curl -X POST http://localhost:3000/refresh -H "Authorization: Bearer $API_SECRET"
# Resposta:
# { "status": "refreshed", "version": "1.0.0" }
```

### Histórico de versões

`GET /api/releases/history` (auth) devolve as últimas 30 releases com notas cortadas em 200 caracteres (formato legado). Com `?full=1` devolve `activeVersion`, `latestVersion` e, por release, `notes` completas, `isActive`, `isLatest`, `hasWindowsInstaller` e `files` (arquivos locais da versão, sem `.blockmap`).

### Status agregado

`GET /api/status` (auth) devolve `latestVersion`, `latestReleaseDate`, `activeVersion`, `servedVersion` (fixada ou a mais recente), `minVersion` (emergência global), `sseClients`, `fleet { total, online, byVersion[] }`, `forcedTerminals` e `forcedCompanies`.

### Frota (inventário de terminais + update forçado)

Cada PDV envia um heartbeat (boot, a cada 30 min e ao logar) e conecta o SSE com `?terminalId=`.

| Rota | Método | Auth | Descrição |
|------|--------|:----:|-----------|
| `/fleet/heartbeat` | `POST` | não | `{ terminalId, terminalName, version, platform, arch, companyId?, unitId?, userId?, userName?, userEmail? }` → `204` |
| `/min-version.json?terminalId=X` | `GET` | não | `{ "minVersion": "x.y.z" \| null }` = maior entre a emergência global e a forçada para X |
| `/api/fleet[?companyId=X]` | `GET` | sim | Lista terminais (`online`, `lastSeen`, `version`, usuário, `forcedMinVersion`, `companyForcedMinVersion`, `effectiveMinVersion`); `companyId` filtra pela empresa (atual ou última vista) |
| `/api/fleet/:terminalId/force` | `POST` | sim | `{ minVersion }` — modal obrigatório só nesse terminal (SSE imediato se online; senão no próximo boot). `404` se o terminal não está no inventário; `400` se `minVersion` não for semver `x.y.z` |
| `/api/fleet/:terminalId/force` | `DELETE` | sim | Cancela o forçado individual. Se ainda houver emergência global ativa, o terminal continua obrigado: recebe `emergency` com o `minVersion` global em vez de `emergency-clear` |
| `/api/fleet/:terminalId/logout` | `POST` | sim | Envia SSE `logout` para o terminal (se online); o PDV encerra a sessão — se houver venda aberta, ao fechá-la |
| `/api/fleet/:terminalId` | `DELETE` | sim | Remove do inventário |
| `/api/companies/forced` | `GET` | sim | `{ companies: [{ companyId, minVersion, createdAt, terminals, online }] }` |
| `/api/companies/:companyId/force` | `POST` | sim | `{ minVersion }` — exige a versão em todos os terminais da empresa (SSE imediato nos online; os demais pegam no boot e quando aparecerem). Responde `{ terminals, online }`; `400` se não for `x.y.z`. Não dá `404`: empresa sem terminal fica gravada |
| `/api/companies/:companyId/force` | `DELETE` | sim | Cancela o forçado da empresa (idempotente). Terminais com exigência global ou individual continuam obrigados |

A exigência efetiva de um terminal é sempre a **maior** entre a global, a individual e a da empresa. `DELETE /api/emergency` (global) não fecha o modal de terminais com forçado individual ou da empresa: eles recebem `emergency` com a própria exigência (que pode ser menor que a global cancelada). `POST /api/companies/:companyId/force` responde `409` acima de 5000 empresas com exigência.

**Confiança na empresa do terminal:** `companyId` vem do heartbeat público, sem autenticação — o `terminalId` funciona como identificador secreto. Quem souber o `terminalId` de outro terminal pode mudar a empresa dele (e, com isso, a exigência por empresa que vale pra ele) até o próximo heartbeat logado do terminal verdadeiro. A empresa serve para exibir e direcionar exigências, nunca para autorizar nada.

O estado (emergência, pin, forçados individuais, frota) fica em `DATA_DIR/state.json` e sobrevive a restarts.

## Guia do desenvolvedor

### Estrutura do projeto

```
src/
  index.ts              # Entry point — monta as rotas e inicia o servidor
  github.ts             # GitHubCache — consulta e cacheia releases do GitHub
  storage.ts            # Storage — lê binários locais, calcula sha512
  routes/
    update.ts           # Rotas /latest.yml, /latest-mac.yml, /latest-linux.yml
    download.ts         # Rotas /download/:filename, /download/latest/:platform
releases/               # Diretório dos binários (gitignored)
```

### Adicionando binários

Coloque os arquivos de build na pasta `releases/` seguindo a convenção de nomes do Electron Forge/Builder. O servidor identifica a plataforma pela extensão:

| Plataforma | Extensões aceitas |
|------------|-------------------|
| Windows | `.exe`, `.msi` |
| macOS | `.dmg`, `.zip` |
| Linux | `.AppImage`, `.deb`, `.rpm`, `.snap` |

O nome do arquivo **deve conter o número da versão** para que o servidor consiga associá-lo à release do GitHub. Exemplos:

```
releases/
  papaya-pdv-Setup-1.0.0.exe
  papaya-pdv-1.0.0-arm64.dmg
  papaya-pdv-1.0.0.AppImage
```

### Configurando o app Electron (client)

No seu `forge.config.ts`, configure o publish para apontar ao servidor:

```ts
// forge.config.ts
const config: ForgeConfig = {
  publishers: [
    {
      name: '@electron-forge/publisher-custom',
      config: {}
    }
  ]
};
```

No código do app Electron, configure o `electron-updater`:

```ts
// main.ts
import { autoUpdater } from 'electron-updater';

autoUpdater.setFeedURL({
  provider: 'generic',
  url: 'https://seu-servidor.com'
});

autoUpdater.checkForUpdatesAndNotify();
```

### Fluxo de deploy de uma nova versão

1. Faça o build do app Electron com a nova versão
2. Copie os binários gerados para a pasta `releases/` do servidor
3. Crie uma release no GitHub com a tag correspondente (ex: `v1.1.0`)
4. O servidor detecta a nova versão automaticamente (ou force com `POST /refresh`)
5. Os clients receberão a atualização na próxima verificação

### Cache e performance

- **GitHub API**: cacheado em memória por 15 min (configurável via `CACHE_TTL`)
- **Metadados de arquivos** (sha512, size): cacheados até chamar `POST /refresh` ou reiniciar o servidor
- Se o GitHub estiver indisponível, o servidor retorna o cache stale enquanto houver dados anteriores
