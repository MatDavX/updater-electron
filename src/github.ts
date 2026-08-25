export interface GitHubAsset {
  url: string;
  name: string;
  browser_download_url: string;
  size: number;
}

interface GitHubRelease {
  tag_name: string;
  name: string;
  body: string;
  published_at: string;
  assets: GitHubAsset[];
  draft: boolean;
}

export interface CachedRelease {
  version: string;
  notes: string;
  releaseDate: string;
  assets: GitHubAsset[];
}

export class GitHubCache {
  private cache: CachedRelease | null = null;
  private lastFetch = 0;
  private allReleasesCache: CachedRelease[] = [];
  private allReleasesLastFetch = 0;
  private readonly account: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly ttl: number;

  constructor() {
    this.account = Bun.env.GITHUB_ACCOUNT ?? "";
    this.repo = Bun.env.GITHUB_REPO ?? "";
    this.token = Bun.env.GITHUB_TOKEN ?? "";
    this.ttl = Number(Bun.env.CACHE_TTL) || 900_000;

    if (!this.account || !this.repo) {
      console.error(
        "WARNING: GITHUB_ACCOUNT and GITHUB_REPO are required.",
      );
    }
  }

  async getLatest(): Promise<CachedRelease | null> {
    const now = Date.now();
    if (this.cache && now - this.lastFetch < this.ttl) {
      return this.cache;
    }

    try {
      await this.refresh();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[github] Failed to fetch release: ${msg}`);
      if (this.cache) return this.cache;
    }

    return this.cache;
  }

  async refresh(): Promise<void> {
    const url = `https://api.github.com/repos/${this.account}/${this.repo}/releases/latest`;
    const headers = this.buildHeaders();
    const res = await fetch(url, { headers });

    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
    }

    const release: GitHubRelease = await res.json();
    const version = release.tag_name.replace(/^v/, "");

    this.cache = {
      version,
      notes: release.body ?? "",
      releaseDate: release.published_at,
      assets: release.assets,
    };
    this.lastFetch = Date.now();
    console.log(`[github] Cached release v${version} (${release.assets.length} assets)`);
  }

  // Força o próximo getAllReleases()/getRelease() a rebuscar no GitHub em vez
  // de servir o cache com TTL de até `ttl` ms. Chamado logo após criar um
  // release para que ele apareça na hora no dropdown de "Controle de Versão"
  // (que lê `allReleasesCache`) em vez de esperar o TTL expirar.
  invalidateAllReleases(): void {
    this.allReleasesLastFetch = 0;
  }

  async getAllReleases(): Promise<CachedRelease[]> {
    const now = Date.now();
    if (this.allReleasesCache.length > 0 && now - this.allReleasesLastFetch < this.ttl) {
      return this.allReleasesCache;
    }

    try {
      await this.refreshAll();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[github] Failed to fetch all releases: ${msg}`);
      if (this.allReleasesCache.length > 0) return this.allReleasesCache;
    }

    return this.allReleasesCache;
  }

  async getRelease(version: string): Promise<CachedRelease | null> {
    const releases = await this.getAllReleases();
    return releases.find((r) => r.version === version) ?? null;
  }

  async getPreviousRelease(): Promise<CachedRelease | null> {
    const releases = await this.getAllReleases();
    return releases[1] ?? null;
  }

  async createRelease(tag: string, name: string, body: string): Promise<{ html_url: string }> {
    const url = `https://api.github.com/repos/${this.account}/${this.repo}/releases`;
    const headers = this.buildHeaders();
    headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: false }),
    });

    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
    }

    return res.json();
  }

  findAsset(release: CachedRelease, filename: string): GitHubAsset | null {
    return release.assets.find((asset) => asset.name === filename) ?? null;
  }

  findPlatformAsset(release: CachedRelease, platform: string): GitHubAsset | null {
    const patterns: Record<string, RegExp[]> = {
      win32: [/\.exe$/i, /\.msi$/i, /\.nupkg$/i],
      darwin: [/\.dmg$/i, /\.zip$/i],
      linux: [/\.AppImage$/i, /\.deb$/i, /\.rpm$/i, /\.snap$/i],
    };
    const platformPatterns = patterns[platform];
    if (!platformPatterns) return null;

    return release.assets.find((asset) =>
      platformPatterns.some((pattern) => pattern.test(asset.name))
    ) ?? null;
  }

  async fetchAsset(asset: GitHubAsset, extraHeaders: Record<string, string> = {}): Promise<Response> {
    const headers = { ...this.buildHeaders(), ...extraHeaders };
    headers.Accept = "application/octet-stream";

    const res = await fetch(asset.url, { headers, redirect: "follow" });
    if (!res.ok && res.status !== 416) {
      throw new Error(`GitHub asset ${asset.name} returned ${res.status}: ${await res.text()}`);
    }

    return res;
  }

  async fetchAssetText(asset: GitHubAsset): Promise<string> {
    const res = await this.fetchAsset(asset);
    return res.text();
  }

  getLastFetchTime(): number {
    return this.lastFetch;
  }

  getTTL(): number {
    return this.ttl;
  }

  getRepoUrl(): string {
    return `https://github.com/${this.account}/${this.repo}`;
  }

  private async refreshAll(): Promise<void> {
    const url = `https://api.github.com/repos/${this.account}/${this.repo}/releases?per_page=10`;
    const headers = this.buildHeaders();
    const res = await fetch(url, { headers });

    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
    }

    const releases: GitHubRelease[] = await res.json();
    // `/releases` inclui drafts (requisição autenticada); um draft órfão com o
    // mesmo tag_name de um release publicado passaria na frente em .find() e
    // mascararia os assets reais (ex.: build re-disparado deixou draft sem
    // o instalador win32, ver histórico do v1.2.2).
    this.allReleasesCache = releases
      .filter((r) => !r.draft)
      .map((r) => ({
        version: r.tag_name.replace(/^v/, ""),
        notes: r.body ?? "",
        releaseDate: r.published_at,
        assets: r.assets,
      }));
    this.allReleasesLastFetch = Date.now();
    console.log(`[github] Cached ${this.allReleasesCache.length} releases`);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "electron-update-server",
    };
    if (this.token) {
      headers.Authorization = `token ${this.token}`;
    }
    return headers;
  }
}
