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
  });
});
