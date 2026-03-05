import { Elysia } from "elysia";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";

export function dashboardRoutes(github: GitHubCache, storage: Storage) {
  return new Elysia().get("/", async () => {
    const release = await github.getLatest();
    const files = await storage.getDetailedList();
    const lastFetch = github.getLastFetchTime();
    const ttl = github.getTTL();
    const cacheAge = lastFetch ? Math.round((Date.now() - lastFetch) / 1000 / 60) : null;
    const cacheRemaining = lastFetch ? Math.max(0, Math.round((ttl - (Date.now() - lastFetch)) / 1000 / 60)) : null;
    const repoUrl = github.getRepoUrl();

    return new Response(buildHTML(release, files, cacheAge, cacheRemaining, repoUrl), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function platformLabel(platform: string | null): string {
  const labels: Record<string, string> = {
    win32: "Windows",
    darwin: "macOS",
    linux: "Linux",
  };
  return platform ? labels[platform] ?? platform : "Desconhecido";
}

function platformIcon(platform: string | null): string {
  const icons: Record<string, string> = {
    win32: "&#x1F5A5;",
    darwin: "&#x1F34E;",
    linux: "&#x1F427;",
  };
  return platform ? icons[platform] ?? "&#x1F4E6;" : "&#x1F4E6;";
}

interface FileInfo {
  filename: string;
  size: number;
  platform: string | null;
  sha512: string;
}

interface ReleaseInfo {
  version: string;
  notes: string;
  releaseDate: string;
}

function buildHTML(
  release: ReleaseInfo | null,
  files: FileInfo[],
  cacheAge: number | null,
  cacheRemaining: number | null,
  repoUrl: string,
): string {
  const version = release?.version ?? "—";
  const releaseDate = release?.releaseDate
    ? new Date(release.releaseDate).toLocaleDateString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
  const notes = release?.notes ?? "Nenhuma release encontrada";

  const fileRows = files
    .map(
      (f) => `
      <tr>
        <td>${platformIcon(f.platform)} ${f.filename}</td>
        <td>${platformLabel(f.platform)}</td>
        <td>${formatSize(f.size)}</td>
        <td><code title="${f.sha512}">${f.sha512.substring(0, 16)}...</code></td>
        <td><button class="btn btn-danger btn-sm" onclick="deleteFile('${f.filename}')">Deletar</button></td>
      </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Electron Update Server</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117;
      color: #e6edf3;
      min-height: 100vh;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 24px; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 0;
      border-bottom: 1px solid #30363d;
      margin-bottom: 24px;
    }
    header h1 { font-size: 20px; font-weight: 600; }
    header a { color: #58a6ff; text-decoration: none; font-size: 14px; }
    header a:hover { text-decoration: underline; }
    .cards {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    .card {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 20px;
    }
    .card-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
    .card-value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .card-sub { font-size: 12px; color: #8b949e; margin-top: 4px; }
    .section {
      background: #161b22;
      border: 1px solid #30363d;
      border-radius: 8px;
      padding: 20px;
      margin-bottom: 16px;
    }
    .section-title {
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 12px;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .notes {
      white-space: pre-wrap;
      font-size: 14px;
      color: #c9d1d9;
      line-height: 1.6;
      max-height: 200px;
      overflow-y: auto;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 14px;
    }
    th {
      text-align: left;
      padding: 8px 12px;
      border-bottom: 1px solid #30363d;
      color: #8b949e;
      font-weight: 500;
      font-size: 12px;
      text-transform: uppercase;
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid #21262d;
    }
    code {
      background: #0d1117;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
    }
    .btn {
      padding: 6px 16px;
      border-radius: 6px;
      border: 1px solid #30363d;
      background: #21262d;
      color: #e6edf3;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: background 0.15s;
    }
    .btn:hover { background: #30363d; }
    .btn-primary { background: #238636; border-color: #2ea043; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { background: #da3633; border-color: #f85149; padding: 4px 10px; font-size: 12px; }
    .btn-danger:hover { background: #f85149; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .upload-zone {
      border: 2px dashed #30363d;
      border-radius: 8px;
      padding: 40px;
      text-align: center;
      cursor: pointer;
      transition: border-color 0.2s, background 0.2s;
    }
    .upload-zone:hover, .upload-zone.dragover {
      border-color: #58a6ff;
      background: rgba(88, 166, 255, 0.05);
    }
    .upload-zone p { color: #8b949e; font-size: 14px; }
    .upload-zone .upload-icon { font-size: 32px; margin-bottom: 8px; }
    input[type="file"] { display: none; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 13px; color: #8b949e; margin-bottom: 4px; }
    .form-group input, .form-group textarea {
      width: 100%;
      padding: 8px 12px;
      background: #0d1117;
      border: 1px solid #30363d;
      border-radius: 6px;
      color: #e6edf3;
      font-size: 14px;
      font-family: inherit;
    }
    .form-group textarea { min-height: 80px; resize: vertical; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .toast {
      position: fixed;
      bottom: 20px;
      right: 20px;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      z-index: 1000;
      opacity: 0;
      transform: translateY(10px);
      transition: opacity 0.3s, transform 0.3s;
    }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.success { background: #238636; color: #fff; }
    .toast.error { background: #da3633; color: #fff; }
    .empty { text-align: center; padding: 24px; color: #8b949e; }
    .header-actions { display: flex; gap: 8px; align-items: center; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Electron Update Server</h1>
      <div class="header-actions">
        <a href="${repoUrl}" target="_blank">${repoUrl.replace("https://github.com/", "")}</a>
        <button class="btn" onclick="refreshCache()">Refresh Cache</button>
      </div>
    </header>

    <div class="cards">
      <div class="card">
        <div class="card-label">Versão Atual</div>
        <div class="card-value" id="version">${version}</div>
        <div class="card-sub">${releaseDate}</div>
      </div>
      <div class="card">
        <div class="card-label">Arquivos Locais</div>
        <div class="card-value" id="file-count">${files.length}</div>
        <div class="card-sub">no diretório releases/</div>
      </div>
      <div class="card">
        <div class="card-label">Cache</div>
        <div class="card-value" id="cache-status">${cacheAge !== null ? `${cacheAge}min` : "—"}</div>
        <div class="card-sub">${cacheRemaining !== null ? `${cacheRemaining}min restantes` : "sem cache"}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        Release Notes
        ${release ? `<a href="${repoUrl}/releases/tag/v${release.version}" target="_blank" class="btn btn-sm">Ver no GitHub &rarr;</a>` : ""}
      </div>
      <div class="notes">${notes || "Sem notas"}</div>
    </div>

    <div class="section">
      <div class="section-title">
        Arquivos Locais
      </div>
      ${
        files.length > 0
          ? `<table>
          <thead>
            <tr>
              <th>Arquivo</th>
              <th>Plataforma</th>
              <th>Tamanho</th>
              <th>SHA512</th>
              <th></th>
            </tr>
          </thead>
          <tbody>${fileRows}</tbody>
        </table>`
          : '<div class="empty">Nenhum arquivo na pasta releases/</div>'
      }
    </div>

    <div class="section">
      <div class="section-title">Upload de Binários</div>
      <div class="upload-zone" id="upload-zone" onclick="document.getElementById('file-input').click()">
        <div class="upload-icon">&#x2B06;&#xFE0F;</div>
        <p>Arraste arquivos aqui ou clique para selecionar</p>
        <p style="font-size:12px; margin-top:4px">.exe, .msi, .dmg, .zip, .AppImage, .deb, .rpm, .snap</p>
      </div>
      <input type="file" id="file-input" multiple accept=".exe,.msi,.dmg,.zip,.AppImage,.deb,.rpm,.snap" />
    </div>

    <div class="section">
      <div class="section-title">Criar Release no GitHub</div>
      <form id="release-form" onsubmit="createRelease(event)">
        <div class="form-row">
          <div class="form-group">
            <label>Tag (ex: v1.2.0)</label>
            <input type="text" name="tag" required placeholder="v1.2.0" />
          </div>
          <div class="form-group">
            <label>Nome</label>
            <input type="text" name="name" placeholder="Release v1.2.0" />
          </div>
        </div>
        <div class="form-group">
          <label>Release Notes</label>
          <textarea name="notes" placeholder="- Bug fixes&#10;- New features"></textarea>
        </div>
        <button type="submit" class="btn btn-primary">Criar Release</button>
      </form>
    </div>
  </div>

  <div class="toast" id="toast"></div>

  <script>
    function showToast(message, type = 'success') {
      const t = document.getElementById('toast');
      t.textContent = message;
      t.className = 'toast ' + type + ' show';
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    async function refreshCache() {
      try {
        const res = await fetch('/refresh', { method: 'POST' });
        const data = await res.json();
        if (data.status === 'refreshed') {
          showToast('Cache atualizado! v' + data.version);
          setTimeout(() => location.reload(), 500);
        } else {
          showToast(data.message || 'Erro ao atualizar', 'error');
        }
      } catch (e) {
        showToast('Erro de conexão', 'error');
      }
    }

    async function deleteFile(filename) {
      if (!confirm('Deletar ' + filename + '?')) return;
      try {
        const res = await fetch('/api/files/' + encodeURIComponent(filename), { method: 'DELETE' });
        const data = await res.json();
        if (data.status === 'deleted') {
          showToast(filename + ' deletado');
          setTimeout(() => location.reload(), 500);
        } else {
          showToast(data.error || 'Erro ao deletar', 'error');
        }
      } catch (e) {
        showToast('Erro de conexão', 'error');
      }
    }

    async function uploadFile(file) {
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: form });
        const data = await res.json();
        if (data.status === 'uploaded') {
          showToast(data.filename + ' enviado');
          return true;
        } else {
          showToast(data.error || 'Erro no upload', 'error');
          return false;
        }
      } catch (e) {
        showToast('Erro de conexão', 'error');
        return false;
      }
    }

    async function createRelease(e) {
      e.preventDefault();
      const form = e.target;
      const body = {
        tag: form.tag.value,
        name: form.name.value,
        notes: form.notes.value,
      };
      try {
        const res = await fetch('/api/releases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.status === 'created') {
          showToast('Release criada!');
          form.reset();
          setTimeout(() => location.reload(), 500);
        } else {
          showToast(data.error || 'Erro ao criar release', 'error');
        }
      } catch (e) {
        showToast('Erro de conexão', 'error');
      }
    }

    // File input
    document.getElementById('file-input').addEventListener('change', async (e) => {
      const files = e.target.files;
      for (const file of files) {
        await uploadFile(file);
      }
      setTimeout(() => location.reload(), 500);
    });

    // Drag and drop
    const zone = document.getElementById('upload-zone');
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      zone.classList.remove('dragover');
      const files = e.dataTransfer.files;
      for (const file of files) {
        await uploadFile(file);
      }
      setTimeout(() => location.reload(), 500);
    });
  </script>
</body>
</html>`;
}
