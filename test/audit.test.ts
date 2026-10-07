import { afterAll, beforeAll, describe, it } from "bun:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { auditRoutes, collectAppRouterRoutes, defaultConcurrency, summarize, type FetchLike } from "../src/index.js";

const validHtml = '<a class="skip-link" href="#main-content">Skip</a><main id="main-content"></main>';

describe("auditRoutes", () => {
  it("fetches route output and reports the route that violates the contract", async () => {
    const responses = new Map([
      ["http://app.test/valid", validHtml],
      ["http://app.test/missing", '<a href="#main-content">Skip</a><main>Missing target</main>'],
    ]);
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return new Response(responses.get(url) ?? "Not found", { status: responses.has(url) ? 200 : 404 });
    };

    const results = await auditRoutes({ baseUrl: "http://app.test", routes: ["/valid", "/missing"], fetchImpl });

    assert.deepEqual(calls, ["http://app.test/valid", "http://app.test/missing"]);
    assert.equal(results[0]?.ok, true);
    assert.equal(results[1]?.ok, false);
    assert.equal(results[1]?.route, "/missing");
    assert.equal(results[1]?.unauditable, false);
  });

  it("marks an HTTP error or an error shell unauditable, and a hang timed out", async () => {
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/down")) return new Response("boom", { status: 500 });
      if (url.endsWith("/shell")) return new Response("<div>__ERR__</div>", { status: 200 });
      return new Promise((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    };

    const results = await auditRoutes({
      baseUrl: "http://app.test/",
      routes: ["/down", "/shell", "/hang"],
      fetchImpl,
      timeoutMs: 20,
      unauditableMarkers: ["__ERR__"],
    });

    assert.equal(results[0]?.unauditable, true);
    assert.match(results[0]?.issues[0] ?? "", /HTTP 500/);
    assert.equal(results[1]?.unauditable, true);
    assert.equal(results[2]?.timedOut, true);
    assert.equal(results[2]?.unauditable, false, "a timeout is not an outage to tolerate");

    const report = summarize(results);
    assert.equal(report.exitCode, 1);
    assert.equal(report.timedOut.length, 1);
    assert.equal(report.unauditable.length, 2);
    assert.equal(report.violations.length, 0);
    assert.equal(report.audited, 0);
  });

  it("keeps result order under concurrency and judges anchors across routes", async () => {
    const pages: Record<string, string> = {
      "/a": validHtml + '<a href="#only-on-b">x</a><a href="#nowhere">y</a>',
      "/b": validHtml + '<div id="only-on-b"></div>',
      "/c": validHtml,
    };
    const fetchImpl: FetchLike = async (url) => {
      const route = new URL(url).pathname;
      await new Promise((resolve) => setTimeout(resolve, route === "/a" ? 15 : 1));
      return new Response(pages[route] ?? "", { status: 200 });
    };

    const results = await auditRoutes({ baseUrl: "http://app.test", routes: ["/a", "/b", "/c"], fetchImpl, concurrency: 3 });
    assert.deepEqual(results.map((result) => result.route), ["/a", "/b", "/c"]);

    const report = summarize(results);
    assert.deepEqual(report.unresolvedAnchors, [{ route: "/a", missing: ["nowhere"] }]);
    assert.equal(report.exitCode, 1);
    assert.equal(report.audited, 3);
  });
});

describe("collectAppRouterRoutes", () => {
  let appDir: string;

  beforeAll(() => {
    appDir = mkdtempSync(join(tmpdir(), "landmark-audit-app-"));
    const page = (...segments: string[]) => {
      mkdirSync(join(appDir, ...segments), { recursive: true });
      writeFileSync(join(appDir, ...segments, "page.tsx"), "export default () => null;");
    };
    page();
    page("about");
    page("(marketing)", "pricing");
    // A parallel slot is dropped from the URL: app/@modal/photo/page.tsx serves /photo.
    page("@modal", "photo");
    page("api", "ignored");
    page("posts", "[slug]");
    mkdirSync(join(appDir, "no-page"));
    writeFileSync(join(appDir, "no-page", "layout.tsx"), "");
  });

  afterAll(() => rmSync(appDir, { recursive: true, force: true }));

  it("lists every page, strips route groups and slots, skips api, and samples dynamic routes", async () => {
    const routes = await collectAppRouterRoutes({ appDir, samples: { "/posts/[slug]": ["/posts/hello", "/posts/world"] } });
    assert.deepEqual(routes, ["/", "/about", "/photo", "/posts/hello", "/posts/world", "/pricing"]);
  });

  it("throws when a dynamic page has no sample, so adding a route forces a decision", async () => {
    await assert.rejects(collectAppRouterRoutes({ appDir }), /\/posts\/\[slug\] has no representative URL/);
  });
});

describe("defaultConcurrency", () => {
  it("scales with the box, never below 4 and never above 8", () => {
    assert.equal(defaultConcurrency(1), 4);
    assert.equal(defaultConcurrency(2), 4);
    assert.equal(defaultConcurrency(4), 8);
    assert.equal(defaultConcurrency(16), 8);
  });
});
