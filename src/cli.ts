#!/usr/bin/env node
/**
 * Usage:
 *   landmark-audit --base-url http://127.0.0.1:3000
 *   landmark-audit --base-url … --routes /,/about,/posts/hello
 *   landmark-audit --base-url … --app-dir app --config landmark-audit.json
 *
 * The server must already be running; any HTTP response from the base URL counts
 * as ready, including a 503 from a degraded health check, because a degraded
 * server still renders every route's markup, which is all this reads.
 *
 * Config (`landmark-audit.json`, all optional):
 *   { "appDir": "app", "samples": { "/posts/[slug]": ["/posts/hello"] },
 *     "routes": ["/extra"], "mainId": "main-content", "skipLinkClass": "skip-link",
 *     "unauditableMarkers": ["__NEXT_DEV_ERROR__"] }
 */
import { existsSync, readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

import { auditRoutes, collectAppRouterRoutes, defaultConcurrency, summarize, DEFAULT_ROUTE_TIMEOUT_MS } from "./index.js";

const args = process.argv.slice(2);
const hasFlag = (flag: string) => args.includes(flag);
const readArg = (flag: string): string | undefined => {
  const index = args.indexOf(flag);
  return index === -1 || index === args.length - 1 ? undefined : args[index + 1];
};

const readPositiveInt = (flag: string, fallback: number): number => {
  const raw = readArg(flag);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`\`${flag}\` must be a positive integer.`);
    process.exit(2);
  }
  return parsed;
};

type Config = {
  appDir?: string;
  samples?: Record<string, string[]>;
  routes?: string[];
  mainId?: string;
  skipLinkClass?: string;
  unauditableMarkers?: string[];
};

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((entry) => typeof entry === "string");

const readConfig = (configPath: string): Config => {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${configPath} did not parse to an object`);
  }
  const record: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
  const config: Config = {};
  if (typeof record.appDir === "string") config.appDir = record.appDir;
  if (typeof record.mainId === "string") config.mainId = record.mainId;
  if (typeof record.skipLinkClass === "string") config.skipLinkClass = record.skipLinkClass;
  if (isStringArray(record.routes)) config.routes = record.routes;
  if (isStringArray(record.unauditableMarkers)) config.unauditableMarkers = record.unauditableMarkers;
  if (record.samples !== null && typeof record.samples === "object" && !Array.isArray(record.samples)) {
    const samples: Record<string, string[]> = {};
    for (const [pattern, urls] of Object.entries(record.samples)) if (isStringArray(urls)) samples[pattern] = urls;
    config.samples = samples;
  }
  return config;
};

const probe = async (baseUrl: string): Promise<string | null> => {
  try {
    await fetch(baseUrl, { method: "GET", signal: AbortSignal.timeout(2500) });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const run = async (): Promise<number> => {
  const baseUrl = readArg("--base-url") ?? process.env.LANDMARKS_BASE_URL ?? "http://127.0.0.1:3000";
  const config = readConfig(resolve(readArg("--config") ?? "landmark-audit.json"));
  const mainId = readArg("--main-id") ?? config.mainId;
  const skipLinkClass = readArg("--skip-link-class") ?? config.skipLinkClass;
  const concurrency = readPositiveInt("--concurrency", defaultConcurrency(availableParallelism()));
  const timeoutMs = readPositiveInt("--route-timeout-ms", DEFAULT_ROUTE_TIMEOUT_MS);

  const explicitRoutes = readArg("--routes")?.split(",").map((route) => route.trim()).filter(Boolean) ?? [];
  const appDir = readArg("--app-dir") ?? config.appDir;
  const discovered = appDir || (explicitRoutes.length === 0 && !config.routes)
    ? await collectAppRouterRoutes({ appDir: resolve(appDir ?? "app"), samples: config.samples })
    : [];
  const routes = [...new Set([...discovered, ...(config.routes ?? []), ...explicitRoutes])].sort();

  if (routes.length === 0) {
    console.error("No routes to audit. Pass --routes, --app-dir, or a config with routes.");
    return 2;
  }

  const unreachable = await probe(baseUrl);
  if (unreachable !== null) {
    console.error(`${baseUrl} is not reachable (${unreachable}). Start the server first.`);
    return 2;
  }

  console.log(`Auditing ${routes.length} routes at ${baseUrl} for main-landmark ownership.`);
  const results = await auditRoutes({
    baseUrl,
    routes,
    concurrency,
    timeoutMs,
    mainId,
    skipLinkClass,
    unauditableMarkers: config.unauditableMarkers,
  });

  if (hasFlag("--json")) {
    console.log(JSON.stringify(results, null, 2));
    return summarize(results).exitCode;
  }

  const report = summarize(results);
  const target = mainId ?? "main-content";

  for (const violation of report.violations) {
    console.error(`\n✗ ${violation.route}  (${violation.finalUrl})`);
    for (const issue of violation.issues) console.error(`    ${issue}`);
  }

  for (const entry of report.unresolvedAnchors) {
    console.error(`\n✗ ${entry.route}`);
    for (const anchor of entry.missing) console.error(`    Links to #${anchor}, which no audited route renders.`);
  }

  // Reported, never counted as a violation: failing the skip-link gate on an
  // unrelated outage is how a check earns a reputation for crying wolf.
  if (report.unauditable.length > 0) {
    console.warn(`\n⚠ ${report.unauditable.length} route(s) could not be audited; they did not render:`);
    for (const route of report.unauditable) {
      const reason = route.status && route.status >= 400
        ? `HTTP ${route.status}`
        : route.issues.find((issue) => /error shell|Fetch failed/.test(issue)) ?? "no route output";
      console.warn(`    ${route.route}  (${reason})`);
    }
    console.warn("  Landmark coverage for these routes is unknown, not clean.");
  }

  // Fatal on its own: a container that cannot reach the routes at all must not
  // produce "0 violations" and a green gate.
  if (report.timedOut.length > 0) {
    console.error(`\n✗ ${report.timedOut.length} route(s) never answered:`);
    for (const route of report.timedOut) console.error(`    ${route.route}  (${route.issues[0]})`);
    console.error("\nThe audit could not run for these routes, so their landmark coverage is unproven.");
    return 1;
  }

  if (report.violations.length > 0 || report.unresolvedAnchors.length > 0) {
    console.error(
      `\n${report.violations.length} landmark problem(s) and ${report.unresolvedAnchors.length} route(s) linking to an id no page renders, across ${report.audited} rendered routes.`,
    );
    console.error(`Each route needs exactly one <main id="${target}"> with exactly one skip link to it, and every #anchor it links to must exist on some page.`);
    return 1;
  }

  console.log(`\n✅ ${report.audited} rendered routes own one <main id="${target}">, and every #anchor they link to exists`);
  return 0;
};

run().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  },
);
