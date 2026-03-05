interface GitHubAsset {
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
  private readonly account: string;
  private readonly repo: string;
  private readonly token: string;
  private readonly ttl: number;

  constructor() {
    this.account = Bun.env.GITHUB_ACCOUNT ?? "";
    this.repo = Bun.env.GITHUB_REPO ?? "";
    this.token = Bun.env.GITHUB_TOKEN ?? "";
    this.ttl = Number(Bun.env.CACHE_TTL) || 900_000; // 15 min

    if (!this.account || !this.repo) {
      throw new Error("GITHUB_ACCOUNT and GITHUB_REPO are required");
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
      // Return stale cache if available
      if (this.cache) return this.cache;
    }

    return this.cache;
  }

  async refresh(): Promise<void> {
    const url = `https://api.github.com/repos/${this.account}/${this.repo}/releases/latest`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "electron-update-server",
    };

    if (this.token) {
      headers.Authorization = `token ${this.token}`;
    }

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

  async createRelease(tag: string, name: string, body: string): Promise<{ html_url: string }> {
    const url = `https://api.github.com/repos/${this.account}/${this.repo}/releases`;
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "electron-update-server",
      "Content-Type": "application/json",
    };

    if (this.token) {
      headers.Authorization = `token ${this.token}`;
    }

    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tag_name: tag,
        name,
        body,
        draft: false,
        prerelease: false,
      }),
    });

    if (!res.ok) {
      throw new Error(`GitHub API returned ${res.status}: ${await res.text()}`);
    }

    return res.json();
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
}
