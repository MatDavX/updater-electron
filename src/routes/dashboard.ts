import { Elysia } from "elysia";
import type { GitHubCache } from "../github";
import type { Storage } from "../storage";
import { getActiveVersion } from "../version-control";
import { sseBroker } from "../sse";

export function dashboardRoutes(github: GitHubCache, storage: Storage) {
  return new Elysia().get("/", async () => {
    const release = await github.getLatest();
    const files = await storage.getDetailedList();
    const lastFetch = github.getLastFetchTime();
    const ttl = github.getTTL();
    const cacheAge = lastFetch ? Math.round((Date.now() - lastFetch) / 1000 / 60) : null;
    const cacheRemaining = lastFetch ? Math.max(0, Math.round((ttl - (Date.now() - lastFetch)) / 1000 / 60)) : null;
    const repoUrl = github.getRepoUrl();
    const activeVersion = getActiveVersion();
    const sseClients = sseBroker.count;

    return new Response(
      buildHTML(release, files, cacheAge, cacheRemaining, repoUrl, activeVersion, sseClients),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  });
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function platformLabel(platform: string | null): string {
  const labels: Record<string, string> = { win32: "Windows", darwin: "macOS", linux: "Linux" };
  return platform ? labels[platform] ?? platform : "Desconhecido";
}

function platformIcon(platform: string | null): string {
  const icons: Record<string, string> = { win32: "&#x1F5A5;", darwin: "&#x1F34E;", linux: "&#x1F427;" };
  return platform ? icons[platform] ?? "&#x1F4E6;" : "&#x1F4E6;";
}

interface FileInfo { filename: string; size: number; platform: string | null; sha512: string; }
interface ReleaseInfo { version: string; notes: string; releaseDate: string; }

function buildHTML(
  release: ReleaseInfo | null,
  files: FileInfo[],
  cacheAge: number | null,
  cacheRemaining: number | null,
  repoUrl: string,
  activeVersion: string | null,
  sseClients: number,
): string {
  const version = release?.version ?? "---";
  const releaseDate = release?.releaseDate
    ? new Date(release.releaseDate).toLocaleDateString("pt-BR", {
        day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit",
      })
    : "---";
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
      background: #0d1117; color: #e6edf3; min-height: 100vh;
    }
    .container { max-width: 960px; margin: 0 auto; padding: 24px; }
    header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 16px 0; border-bottom: 1px solid #30363d; margin-bottom: 24px;
    }
    header h1 { font-size: 20px; font-weight: 600; }
    header a { color: #58a6ff; text-decoration: none; font-size: 14px; }
    header a:hover { text-decoration: underline; }
    .cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
    .card {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px;
    }
    .card-label { font-size: 12px; color: #8b949e; text-transform: uppercase; letter-spacing: 0.5px; }
    .card-value { font-size: 28px; font-weight: 700; margin-top: 4px; }
    .card-sub { font-size: 12px; color: #8b949e; margin-top: 4px; }
    .section {
      background: #161b22; border: 1px solid #30363d; border-radius: 8px;
      padding: 20px; margin-bottom: 16px;
    }
    .section-title {
      font-size: 14px; font-weight: 600; margin-bottom: 12px;
      display: flex; justify-content: space-between; align-items: center;
    }
    .notes { white-space: pre-wrap; font-size: 14px; color: #c9d1d9; line-height: 1.6; max-height: 200px; overflow-y: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #30363d; color: #8b949e; font-weight: 500; font-size: 12px; text-transform: uppercase; }
    td { padding: 10px 12px; border-bottom: 1px solid #21262d; }
    code { background: #0d1117; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
    .btn { padding: 6px 16px; border-radius: 6px; border: 1px solid #30363d; background: #21262d; color: #e6edf3; cursor: pointer; font-size: 13px; font-weight: 500; transition: background 0.15s; }
    .btn:hover { background: #30363d; }
    .btn-primary { background: #238636; border-color: #2ea043; }
    .btn-primary:hover { background: #2ea043; }
    .btn-danger { background: #da3633; border-color: #f85149; padding: 4px 10px; font-size: 12px; }
    .btn-danger:hover { background: #f85149; }
    .btn-warning { background: #9e6a03; border-color: #d29922; }
    .btn-warning:hover { background: #bb8009; }
    .btn-sm { padding: 4px 10px; font-size: 12px; }
    .upload-zone { border: 2px dashed #30363d; border-radius: 8px; padding: 40px; text-align: center; cursor: pointer; transition: border-color 0.2s, background 0.2s; }
    .upload-zone:hover, .upload-zone.dragover { border-color: #58a6ff; background: rgba(88, 166, 255, 0.05); }
    .upload-zone p { color: #8b949e; font-size: 14px; }
    .upload-zone .upload-icon { font-size: 32px; margin-bottom: 8px; }
    input[type="file"] { display: none; }
    .form-group { margin-bottom: 12px; }
    .form-group label { display: block; font-size: 13px; color: #8b949e; margin-bottom: 4px; }
    .form-group input, .form-group textarea {
      width: 100%; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d;
      border-radius: 6px; color: #e6edf3; font-size: 14px; font-family: inherit;
    }
    .form-group textarea { min-height: 80px; resize: vertical; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .toast { position: fixed; bottom: 20px; right: 20px; padding: 12px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; z-index: 1000; opacity: 0; transform: translateY(10px); transition: opacity 0.3s, transform 0.3s; }
    .toast.show { opacity: 1; transform: translateY(0); }
    .toast.success { background: #238636; color: #fff; }
    .toast.error { background: #da3633; color: #fff; }
    .empty { text-align: center; padding: 24px; color: #8b949e; }
    .header-actions { display: flex; gap: 8px; align-items: center; }
    .auth-bar { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; padding: 12px 16px; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
    .auth-bar input { flex: 1; padding: 6px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-size: 13px; font-family: monospace; }
    .auth-bar .status { font-size: 12px; padding: 4px 8px; border-radius: 4px; }
    .auth-bar .status.ok { background: #238636; color: #fff; }
    .auth-bar .status.none { background: #9e6a03; color: #fff; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .badge-green { background: #238636; color: #fff; }
    .badge-yellow { background: #9e6a03; color: #fff; }
    .sse-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #3fb950; margin-right: 6px; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .version-control { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .version-control select { padding: 6px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-size: 13px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Electron Update Server</h1>
      <div class="header-actions">
        <span id="sse-status"><span class="sse-dot"></span><span id="sse-count">${sseClients}</span> clients</span>
        <a href="${repoUrl}" target="_blank">${repoUrl.replace("https://github.com/", "")}</a>
        <button class="btn" onclick="refreshCache()">Refresh Cache</button>
      </div>
    </header>

    <div class="auth-bar">
      <label style="font-size:13px;color:#8b949e;white-space:nowrap;">API Token:</label>
      <input type="password" id="api-token" placeholder="Cole seu API_SECRET aqui..." />
      <button class="btn btn-sm" onclick="saveToken()">Salvar</button>
      <span class="status none" id="auth-status">sem token</span>
    </div>

    <div class="cards">
      <div class="card">
        <div class="card-label">Versao Ativa</div>
        <div class="card-value" id="version">${activeVersion ?? version}</div>
        <div class="card-sub">${activeVersion ? '<span class="badge badge-yellow">pinned</span>' : '<span class="badge badge-green">latest</span>'} ${releaseDate}</div>
      </div>
      <div class="card">
        <div class="card-label">Arquivos Locais</div>
        <div class="card-value" id="file-count">${files.length}</div>
        <div class="card-sub">no diretorio releases/</div>
      </div>
      <div class="card">
        <div class="card-label">Cache</div>
        <div class="card-value" id="cache-status">${cacheAge !== null ? `${cacheAge}min` : "---"}</div>
        <div class="card-sub">${cacheRemaining !== null ? `${cacheRemaining}min restantes` : "sem cache"}</div>
      </div>
      <div class="card">
        <div class="card-label">SSE Clients</div>
        <div class="card-value" id="sse-clients">${sseClients}</div>
        <div class="card-sub">conectados agora</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">
        Controle de Versao
        <div class="version-control">
          <select id="version-select">
            <option value="">Carregando...</option>
          </select>
          <button class="btn btn-warning btn-sm" onclick="pinVersion()">Fixar Versao</button>
          <button class="btn btn-sm" onclick="resetVersion()">Usar Latest</button>
        </div>
      </div>
      <p style="font-size:13px;color:#8b949e;">Fixe uma versao especifica para rollback. Todos os clients receberao esta versao ao inves da latest.</p>
    </div>

    <div class="section">
      <div class="section-title">
        Modo Emergencia
        <div class="version-control">
          <input id="emergency-min" placeholder="minVersion (ex: 1.3.0)" style="padding:6px 10px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#e6edf3;width:160px;" />
          <button class="btn btn-danger btn-sm" onclick="activateEmergency()">Ativar Emergencia</button>
          <button class="btn btn-sm" onclick="clearEmergency()">Desativar</button>
        </div>
      </div>
      <p style="font-size:13px;color:#8b949e;">
        Forca atualizacao OBRIGATORIA: clients com versao &lt; minVersion travam num modal ate atualizar.
        Apps abertos recebem na hora (SSE); apps fechados pegam no boot via /min-version.json.
        Estado atual: <strong id="emergency-status">—</strong>
      </p>
    </div>

    <div class="section">
      <div class="section-title">
        Release Notes
        ${release ? `<a href="${repoUrl}/releases/tag/v${release.version}" target="_blank" class="btn btn-sm">Ver no GitHub &rarr;</a>` : ""}
      </div>
      <div class="notes">${notes || "Sem notas"}</div>
    </div>

    <div class="section">
      <div class="section-title">Arquivos Locais</div>
      ${
        files.length > 0
          ? `<table>
          <thead><tr><th>Arquivo</th><th>Plataforma</th><th>Tamanho</th><th>SHA512</th><th></th></tr></thead>
          <tbody>${fileRows}</tbody>
        </table>`
          : '<div class="empty">Nenhum arquivo na pasta releases/</div>'
      }
    </div>

    <div class="section">
      <div class="section-title">Upload de Binarios</div>
      <div class="upload-zone" id="upload-zone" onclick="document.getElementById('file-input').click()">
        <div class="upload-icon">&#x2B06;&#xFE0F;</div>
        <p>Arraste arquivos aqui ou clique para selecionar</p>
        <p style="font-size:12px; margin-top:4px">.exe, .msi, .dmg, .zip, .AppImage, .deb, .rpm, .snap, .blockmap</p>
      </div>
      <input type="file" id="file-input" multiple accept=".exe,.msi,.dmg,.zip,.AppImage,.deb,.rpm,.snap,.blockmap" />
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
    function getToken() { return localStorage.getItem('api_token') || ''; }

    function authHeaders() {
      const token = getToken();
      const h = {};
      if (token) h['Authorization'] = 'Bearer ' + token;
      return h;
    }

    function saveToken() {
      const token = document.getElementById('api-token').value.trim();
      if (token) {
        localStorage.setItem('api_token', token);
        document.getElementById('auth-status').textContent = 'token salvo';
        document.getElementById('auth-status').className = 'status ok';
        showToast('Token salvo');
      }
    }

    // Restore token on load
    (function() {
      const saved = getToken();
      if (saved) {
        document.getElementById('api-token').value = saved;
        document.getElementById('auth-status').textContent = 'token salvo';
        document.getElementById('auth-status').className = 'status ok';
      }
    })();

    function showToast(message, type = 'success') {
      const t = document.getElementById('toast');
      t.textContent = message;
      t.className = 'toast ' + type + ' show';
      setTimeout(() => t.classList.remove('show'), 3000);
    }

    function handleAuthError(data, res) {
      if (res.status === 401) {
        showToast('Token invalido. Verifique o API_SECRET.', 'error');
        return true;
      }
      return false;
    }

    async function refreshCache() {
      try {
        const res = await fetch('/refresh', { method: 'POST', headers: authHeaders() });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        if (data.status === 'refreshed') {
          showToast('Cache atualizado! v' + data.version);
          setTimeout(() => location.reload(), 500);
        } else {
          showToast(data.message || 'Erro ao atualizar', 'error');
        }
      } catch (e) {
        showToast('Erro de conexao', 'error');
      }
    }

    async function deleteFile(filename) {
      if (!confirm('Deletar ' + filename + '?')) return;
      try {
        const res = await fetch('/api/files/' + encodeURIComponent(filename), { method: 'DELETE', headers: authHeaders() });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        if (data.status === 'deleted') {
          showToast(filename + ' deletado');
          setTimeout(() => location.reload(), 500);
        } else {
          showToast(data.error || 'Erro ao deletar', 'error');
        }
      } catch (e) {
        showToast('Erro de conexao', 'error');
      }
    }

    async function uploadFile(file) {
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await fetch('/api/upload', { method: 'POST', body: form, headers: authHeaders() });
        if (handleAuthError(null, res)) return false;
        const data = await res.json();
        if (data.status === 'uploaded') {
          showToast(data.filename + ' enviado (SHA512 OK)');
          return true;
        } else {
          showToast(data.error || 'Erro no upload', 'error');
          return false;
        }
      } catch (e) {
        showToast('Erro de conexao', 'error');
        return false;
      }
    }

    async function createRelease(e) {
      e.preventDefault();
      const form = e.target;
      const body = { tag: form.tag.value, name: form.name.value, notes: form.notes.value };
      try {
        const res = await fetch('/api/releases', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(body),
        });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        if (data.status === 'created') {
          showToast('Release criada!');
          form.reset();
          setTimeout(() => location.reload(), 500);
        } else {
          showToast(data.error || 'Erro ao criar release', 'error');
        }
      } catch (e) {
        showToast('Erro de conexao', 'error');
      }
    }

    async function loadVersions() {
      try {
        const res = await fetch('/api/releases/history', { headers: authHeaders() });
        const data = await res.json();
        const select = document.getElementById('version-select');
        select.innerHTML = '';
        if (data.releases && data.releases.length > 0) {
          data.releases.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.version;
            opt.textContent = 'v' + r.version + (r.isActive ? ' (ativa)' : '');
            select.appendChild(opt);
          });
        } else {
          select.innerHTML = '<option value="">Nenhuma release</option>';
        }
      } catch (e) {
        console.error('Failed to load versions:', e);
      }
    }

    async function pinVersion() {
      const version = document.getElementById('version-select').value;
      if (!version) return;
      try {
        const res = await fetch('/api/active-version', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ version }),
        });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        if (data.status === 'ok') {
          showToast('Versao fixada em v' + version);
          setTimeout(() => location.reload(), 500);
        } else {
          showToast(data.error || 'Erro', 'error');
        }
      } catch (e) {
        showToast('Erro de conexao', 'error');
      }
    }

    async function resetVersion() {
      try {
        const res = await fetch('/api/active-version', { method: 'DELETE', headers: authHeaders() });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        if (data.status === 'ok') {
          showToast('Usando latest (v' + (data.latestVersion || '?') + ')');
          setTimeout(() => location.reload(), 500);
        } else {
          showToast(data.error || 'Erro', 'error');
        }
      } catch (e) {
        showToast('Erro de conexao', 'error');
      }
    }

    async function loadEmergency() {
      try {
        const res = await fetch('/api/emergency', { headers: authHeaders() });
        if (!res.ok) return;
        const data = await res.json();
        const el = document.getElementById('emergency-status');
        if (data.minVersion) {
          el.textContent = 'ATIVA (minVersion ' + data.minVersion + ')';
          el.style.color = '#f85149';
          document.getElementById('emergency-min').value = data.minVersion;
        } else {
          el.textContent = 'inativa';
          el.style.color = '#3fb950';
        }
      } catch (e) { /* ignore */ }
    }

    async function activateEmergency() {
      const minVersion = document.getElementById('emergency-min').value.trim();
      if (!minVersion) { showToast('Informe a minVersion', 'error'); return; }
      if (!confirm('Ativar emergencia? Clients com versao < ' + minVersion + ' serao bloqueados ate atualizar.')) return;
      try {
        const res = await fetch('/api/emergency', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ minVersion, version: minVersion }),
        });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        if (data.status === 'ok') { showToast('Emergencia ATIVADA (minVersion ' + minVersion + ')'); loadEmergency(); }
        else { showToast(data.error || 'Erro', 'error'); }
      } catch (e) { showToast('Erro de conexao', 'error'); }
    }

    async function clearEmergency() {
      try {
        const res = await fetch('/api/emergency', { method: 'DELETE', headers: authHeaders() });
        if (handleAuthError(null, res)) return;
        const data = await res.json();
        if (data.status === 'ok') { showToast('Emergencia desativada'); loadEmergency(); }
        else { showToast(data.error || 'Erro', 'error'); }
      } catch (e) { showToast('Erro de conexao', 'error'); }
    }

    // File input
    document.getElementById('file-input').addEventListener('change', async (e) => {
      const files = e.target.files;
      for (const file of files) { await uploadFile(file); }
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
      for (const file of files) { await uploadFile(file); }
      setTimeout(() => location.reload(), 500);
    });

    // SSE live updates
    (function connectSSE() {
      const evtSource = new EventSource('/events/updates');
      evtSource.addEventListener('upload', (e) => {
        const data = JSON.parse(e.data);
        showToast('Novo upload: ' + data.filename);
        setTimeout(() => location.reload(), 1000);
      });
      evtSource.addEventListener('release', (e) => {
        const data = JSON.parse(e.data);
        showToast('Nova release: v' + data.version);
        setTimeout(() => location.reload(), 1000);
      });
      evtSource.addEventListener('version-change', (e) => {
        const data = JSON.parse(e.data);
        showToast('Versao alterada: ' + (data.isLatest ? 'latest' : 'v' + data.version));
        setTimeout(() => location.reload(), 1000);
      });
      evtSource.addEventListener('delete', (e) => {
        const data = JSON.parse(e.data);
        showToast('Arquivo removido: ' + data.filename);
        setTimeout(() => location.reload(), 1000);
      });
      evtSource.onerror = () => {
        setTimeout(() => connectSSE(), 5000);
      };
    })();

    // Load version history on page load
    loadVersions();
    loadEmergency();
  </script>
</body>
</html>`;
}
