/**
 * Fetches every route of a server-rendered app and requires each to own exactly
 * one `<main id="…">` and exactly one skip link pointing at it.
 *
 * The skip link is the only way a keyboard or screen-reader user gets past the
 * nav, and it is a single anchor pointed at a single id. A duplicated, missing,
 * or nested landmark breaks it silently, on one route, in a way no type or unit
 * test sees. Layouts, shells, and loading fallbacks all render `<main>` under
 * different conditions, so the only honest check is to fetch the assembled page.
 *
 * axe runs on a DOM and needs a browser per route. This runs on served HTML,
 * which a build container can produce, and it reads the React Server Components
 * flight payload for routes whose landmark is streamed rather than rendered.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";

export interface LandmarkOptions {
  /** The id the route's `<main>` must carry and the skip link must target. Default `main-content`. */
  mainId?: string | undefined;
  /** The class that marks the skip link, so a "back to top" link to the same id is not counted. Default `skip-link`. */
  skipLinkClass?: string | undefined;
  /**
   * Substrings whose presence means the server returned an error shell rather than
   * the route (a dev-server error boundary, say). Such a route is reported as
   * unauditable rather than as a violation.
   */
  unauditableMarkers?: readonly string[] | undefined;
}

const DEFAULTS = { mainId: "main-content", skipLinkClass: "skip-link", unauditableMarkers: [] as readonly string[] };

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const countMatches = (value: string, pattern: RegExp) => [...value.matchAll(pattern)].length;

type Patterns = {
  skipLink: RegExp;
  mainIdAttribute: RegExp;
  flightMainWithTarget: RegExp;
  flightSkipLink: RegExp;
};

/*
 * Most App Router routes are client-streamed, so their landmark never reaches the
 * response as literal markup. It arrives as an RSC flight row instead:
 *
 *   ["$","main",null,{"id":"main-content","tabIndex":-1,...}]
 *
 * embedded in a script, with the quotes backslash-escaped. Scanning only for
 * `<main>` tags reported half the routes as missing a landmark they had. These
 * patterns tolerate the escaping and the surrounding props.
 *
 * The flight format is React-internal. This tracks the shape React 19 emits.
 */
const buildPatterns = (mainId: string, skipLinkClass: string): Patterns => {
  const id = escapeRegExp(mainId);
  const cls = escapeRegExp(skipLinkClass);
  return {
    // Attribute order varies, so both are matched by lookahead rather than by sequence.
    skipLink: new RegExp(
      String.raw`<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\b${cls}\b)(?=[^>]*\bhref\s*=\s*["']#${id}["'])[^>]*>`,
      "gi",
    ),
    mainIdAttribute: new RegExp(String.raw`\bid\s*=\s*["']${id}["']`, "gi"),
    flightMainWithTarget: new RegExp(
      String.raw`\\?"main\\?"\s*,\s*null\s*,\s*\{[^{}]*\\?"id\\?"\s*:\s*\\?"${id}\\?"`,
      "g",
    ),
    flightSkipLink: new RegExp(String.raw`\\?"className\\?"\s*:\s*\\?"(?:[^"\\]*\s)?${cls}(?:\s[^"\\]*)?\\?"`, "g"),
  };
};

const resolveOptions = (options: LandmarkOptions = {}) => {
  const mainId = options.mainId ?? DEFAULTS.mainId;
  const skipLinkClass = options.skipLinkClass ?? DEFAULTS.skipLinkClass;
  return {
    mainId,
    skipLinkClass,
    unauditableMarkers: options.unauditableMarkers ?? DEFAULTS.unauditableMarkers,
    patterns: buildPatterns(mainId, skipLinkClass),
  };
};

/**
 * Presence only, deliberately not counts. React re-emits a segment's rows when a
 * stream resumes, so the same single landmark can legitimately appear twice.
 * A streamed route is checked for "declares its landmark and a link to it";
 * duplicate and nesting detection stay with routes that ship literal markup.
 */
const inspectFlightPayload = (html: string, patterns: Patterns) => ({
  hasMainWithTarget: countMatches(html, patterns.flightMainWithTarget) > 0,
  hasSkipLink: countMatches(html, patterns.flightSkipLink) > 0,
});

export type AnchorInspection = { ids: string[]; anchors: string[] };

/**
 * The in-page anchors a rendered page links to, and the ids it carries.
 *
 * A dead `#anchor` fails silently: the browser stays put, and nothing in a type
 * check, a unit test or the landmark audit notices. Ids come from the literal
 * markup and from the flight payload, since a streamed route's real markup is
 * escaped JSON in the served response.
 *
 * Both halves are returned rather than diffed here, because the useful question
 * is not per-page. Plenty of targets render only under a condition, so a page
 * can honestly link to an id it is not currently showing. The caller asks the
 * stable question instead: does this id exist anywhere in the app at all.
 */
export const inspectInPageAnchors = (html: string): AnchorInspection => {
  const ids = new Set<string>();
  for (const match of html.matchAll(/\sid="([^"]+)"/g)) if (match[1]) ids.add(match[1]);
  for (const match of html.matchAll(/\\"id\\":\\"([^"\\]+)\\"/g)) if (match[1]) ids.add(match[1]);

  const anchors = new Set<string>();
  for (const match of html.matchAll(/\shref="#([^"]+)"/g)) {
    // `#top` is the document itself, and needs no id to work.
    if (match[1] && match[1] !== "top") anchors.add(match[1]);
  }

  const byName = (left: string, right: string) => left.localeCompare(right);
  return { ids: [...ids].sort(byName), anchors: [...anchors].sort(byName) };
};

export type UnresolvedAnchors = { route: string; missing: string[] };

/**
 * Anchors no audited route renders an id for, per route that links to one.
 * Aggregated across every route before judging, so a target that exists on some
 * page in some state is real and only a target that exists nowhere fails.
 */
export const collectUnresolvedAnchors = (
  results: readonly { route: string; anchorIds?: readonly string[] | undefined; inPageAnchors?: readonly string[] | undefined }[],
): UnresolvedAnchors[] => {
  const rendered = new Set<string>();
  for (const result of results) for (const id of result.anchorIds ?? []) rendered.add(id);

  return results
    .flatMap((result) => {
      const missing = (result.inPageAnchors ?? []).filter((anchor) => !rendered.has(anchor));
      return missing.length > 0 ? [{ route: result.route, missing }] : [];
    })
    .sort((left, right) => left.route.localeCompare(right.route));
};

export type HtmlInspection = {
  mainCount: number;
  mainContentIdCount: number;
  skipLinkCount: number;
  nestedMain: boolean;
  issues: string[];
};

export const inspectMainContentHtml = (html: string, options: LandmarkOptions = {}): HtmlInspection => {
  const { mainId, patterns, unauditableMarkers } = resolveOptions(options);
  const mainTags = [...html.matchAll(/<\/?main\b[^>]*>/gi)].map((match) => match[0]);
  const openingMainTags = mainTags.filter((tag) => !/^<\/main\b/i.test(tag));
  const mainContentIdCount = countMatches(html, patterns.mainIdAttribute);
  const skipLinkCount = countMatches(html, patterns.skipLink);
  const mainWithTargetCount = openingMainTags.filter((tag) => {
    patterns.mainIdAttribute.lastIndex = 0;
    return patterns.mainIdAttribute.test(tag);
  }).length;
  let mainDepth = 0;
  let nestedMain = false;

  for (const tag of mainTags) {
    if (/^<\/main\b/i.test(tag)) {
      mainDepth = Math.max(0, mainDepth - 1);
      continue;
    }
    if (mainDepth > 0) nestedMain = true;
    mainDepth += 1;
  }

  const errorShell = unauditableMarkers.some((marker) => html.includes(marker));

  /*
   * A streamed route's real landmark arrives in the flight payload. Some also
   * flush a placeholder <main> first (a centered loading shell with no id), so
   * the trigger is "the literal markup never produced a correctly-targeted
   * landmark", not "there was no <main>". A route that does ship a targeted one
   * in HTML is judged on that markup, so genuine duplicates and nesting still
   * fail rather than being excused by the payload.
   */
  if (mainWithTargetCount === 0 && !errorShell) {
    const flight = inspectFlightPayload(html, patterns);
    if (flight.hasMainWithTarget) {
      const flightIssues: string[] = [];
      if (!flight.hasSkipLink) flightIssues.push(`Streamed route declares no skip link to #${mainId}.`);
      return {
        mainCount: 1,
        mainContentIdCount: 1,
        skipLinkCount: flight.hasSkipLink ? 1 : 0,
        nestedMain: false,
        issues: flightIssues,
      };
    }
  }

  const issues: string[] = [];
  if (openingMainTags.length !== 1) {
    issues.push(`Expected exactly 1 <main>; found ${openingMainTags.length} <main> elements.`);
  }
  if (mainContentIdCount !== 1) {
    issues.push(`Expected exactly 1 id="${mainId}"; found ${mainContentIdCount} elements.`);
  }
  if (mainWithTargetCount !== 1) {
    issues.push(`Expected id="${mainId}" on the route's <main>; found ${mainWithTargetCount}.`);
  }
  if (skipLinkCount !== 1) {
    issues.push(`Expected exactly 1 skip link target; found ${skipLinkCount}.`);
  }
  if (nestedMain) issues.push("Found nested <main> landmarks.");
  if (errorShell) issues.push("Server returned an error shell instead of the route.");

  return { mainCount: openingMainTags.length, mainContentIdCount, skipLinkCount, nestedMain, issues };
};

/* Next.js App Router route discovery. */

const normalizeRouteSegment = (segment: string): string | null => {
  if (/^\(.*\)$/.test(segment)) return null; // route group
  if (segment.startsWith("@")) return null; // parallel route slot
  return segment;
};

const collectPagePatterns = async (directory: string, segments: string[] = [], patterns: string[] = []): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });

  if (entries.some((entry) => entry.isFile() && /^page\.(?:tsx?|jsx?|mdx?)$/.test(entry.name))) {
    const routeSegments = segments.map(normalizeRouteSegment).filter((segment): segment is string => segment !== null);
    patterns.push(routeSegments.length === 0 ? "/" : `/${routeSegments.join("/")}`);
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "api") continue;
    await collectPagePatterns(path.join(directory, entry.name), [...segments, entry.name], patterns);
  }

  return patterns;
};

export interface RouteDiscoveryOptions {
  /** The App Router directory. Default `./app`. */
  appDir?: string | undefined;
  /**
   * One or more representative URLs per dynamic pattern, e.g.
   * `{ "/posts/[slug]": ["/posts/hello"] }`. A dynamic page with no entry throws,
   * so adding a route forces a decision about how it is audited.
   */
  samples?: Readonly<Record<string, readonly string[]>> | undefined;
}

/** Every page route in an App Router tree, with dynamic patterns replaced by their samples. */
export const collectAppRouterRoutes = async ({ appDir = path.resolve(process.cwd(), "app"), samples = {} }: RouteDiscoveryOptions = {}): Promise<string[]> => {
  const patterns = await collectPagePatterns(appDir);
  const routes: string[] = [];

  for (const pattern of patterns) {
    if (!pattern.includes("[")) {
      routes.push(pattern);
      continue;
    }
    const sampled = samples[pattern];
    if (!sampled || sampled.length === 0) {
      throw new Error(`Dynamic page ${pattern} has no representative URL in samples.`);
    }
    routes.push(...sampled);
  }

  return [...new Set(routes)].sort((left, right) => left.localeCompare(right));
};

/* Fetching. */

export type RouteResult = HtmlInspection & {
  route: string;
  url: string;
  finalUrl: string;
  status: number | null;
  ok: boolean;
  /** The route never rendered (HTTP error, transport failure, error shell), so its landmark is unknown rather than wrong. */
  unauditable: boolean;
  /** The route never answered inside the bound. Not an outage to tolerate: the audit did not run. */
  timedOut: boolean;
  anchorIds: string[];
  inPageAnchors: string[];
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/*
 * A route that never answers used to park a worker forever. Inside a build
 * container the routes render against upstreams the container cannot reach, and
 * an egress that drops packets rather than refusing them leaves the socket open
 * with nothing coming back.
 */
export const DEFAULT_ROUTE_TIMEOUT_MS = 30_000;

export interface AuditOptions extends LandmarkOptions {
  baseUrl: string;
  routes: readonly string[];
  fetchImpl?: FetchLike | undefined;
  concurrency?: number | undefined;
  timeoutMs?: number | undefined;
}

const auditRoute = async (
  { baseUrl, route, fetchImpl, timeoutMs }: { baseUrl: string; route: string; fetchImpl: FetchLike; timeoutMs: number },
  options: LandmarkOptions,
): Promise<RouteResult> => {
  const url = new URL(route, `${baseUrl.replace(/\/$/, "")}/`).toString();

  try {
    const response = await fetchImpl(url, {
      headers: { accept: "text/html" },
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const html = await response.text();
    const inspection = inspectMainContentHtml(html, options);
    const anchors = inspectInPageAnchors(html);
    const issues = [...inspection.issues];
    if (!response.ok) issues.unshift(`Fetch returned HTTP ${response.status}.`);

    const markers = options.unauditableMarkers ?? DEFAULTS.unauditableMarkers;
    const unauditable = !response.ok || markers.some((marker) => html.includes(marker));

    return {
      route,
      url,
      finalUrl: response.url || url,
      status: response.status,
      ok: issues.length === 0,
      unauditable,
      timedOut: false,
      ...inspection,
      anchorIds: anchors.ids,
      inPageAnchors: anchors.anchors,
      issues,
    };
  } catch (error) {
    /*
     * A timeout is not the outage `unauditable` tolerates. That bucket only warns,
     * so folding a timeout into it would turn a hang into a green check reporting
     * "0 violations" precisely when it audited nothing.
     */
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return {
      route,
      url,
      finalUrl: url,
      status: null,
      ok: false,
      unauditable: !timedOut,
      timedOut,
      mainCount: 0,
      mainContentIdCount: 0,
      skipLinkCount: 0,
      nestedMain: false,
      anchorIds: [],
      inPageAnchors: [],
      issues: [
        timedOut
          ? `No response within ${Math.round(timeoutMs / 1000)}s.`
          : `Fetch failed: ${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
};

export const auditRoutes = async ({
  baseUrl,
  routes,
  fetchImpl = (input, init) => globalThis.fetch(input, init),
  concurrency = 4,
  timeoutMs = DEFAULT_ROUTE_TIMEOUT_MS,
  ...landmark
}: AuditOptions): Promise<RouteResult[]> => {
  const results: RouteResult[] = [];
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency, routes.length));

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < routes.length) {
      const index = nextIndex;
      nextIndex += 1;
      const route = routes[index];
      if (route === undefined) break;
      results[index] = await auditRoute({ baseUrl, route, fetchImpl, timeoutMs }, landmark);
    }
  });

  await Promise.all(workers);
  return results;
};

/**
 * Route fetches are mostly waiting while the server compiles each route on demand.
 * Twice the cores, capped at 8, floored at 4: a two-core build container lands on 4,
 * where a route that compiles slowly must not read as a route that never answered,
 * and only a box with cores to spare goes faster.
 */
export const defaultConcurrency = (cores: number): number => Math.min(8, Math.max(4, cores * 2));

export type Report = {
  violations: RouteResult[];
  unauditable: RouteResult[];
  timedOut: RouteResult[];
  unresolvedAnchors: UnresolvedAnchors[];
  audited: number;
  /** 0 clean, 1 failed. */
  exitCode: 0 | 1;
};

/** Sorts results into the buckets a gate reports on. */
export const summarize = (results: readonly RouteResult[]): Report => {
  const unauditable = results.filter((result) => result.unauditable);
  const timedOut = results.filter((result) => result.timedOut);
  const violations = results.filter((result) => !result.ok && !result.unauditable && !result.timedOut);
  const auditedResults = results.filter((result) => !result.unauditable && !result.timedOut);
  const unresolvedAnchors = collectUnresolvedAnchors(auditedResults);
  const failed = timedOut.length > 0 || violations.length > 0 || unresolvedAnchors.length > 0;
  return { violations, unauditable, timedOut, unresolvedAnchors, audited: auditedResults.length, exitCode: failed ? 1 : 0 };
};
