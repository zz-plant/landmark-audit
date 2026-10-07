# landmark-audit

Fetches every route of a server-rendered app and requires each to own exactly one `<main id="main-content">` and exactly one skip link pointing at it. Reads the React Server Components flight payload for routes whose landmark is streamed rather than rendered. Cross-checks every in-page `#anchor` against the ids any route renders.

## Why

The skip link is the only way a keyboard or screen-reader user gets past the navigation, and it is one anchor pointed at one id. A duplicated, missing, or nested landmark breaks it silently, on one route, in a way no type check or unit test sees. Layouts, shells, and loading fallbacks all render `<main>` under different conditions, so the only honest check fetches the assembled page.

axe-core and html-validate both check single pages, and axe runs browserless inside jsdom. Fed the served HTML of one route, axe catches a duplicate or nested `<main>`. It does not flag a skip link whose target is missing, it reports a page with no `<main>` only as "incomplete", and it cannot see a landmark that arrives in the flight payload. html-validate's `no-multiple-main` covers duplicates, and its reference rule skips `href="#…"`.

This tool covers what those leave out:

- **Every route, not one page.** It discovers App Router pages and fails when a dynamic route has no sample URL.
- **Streamed landmarks.** On some streamed routes the landmark never reaches the response as markup. It arrives as a flight row, `["$","main",null,{"id":"main-content",…}]`, escaped inside a script. Scanning for `<main>` alone reported half the routes of the app this came from as missing a landmark they had.
- **Dead in-page anchors, judged across the app.** A `#target` that renders on no route fails; one that renders only on another route, or only in some data state, passes.
- **Gate semantics.** A route that never answers fails the run, and a route that errored is reported as unknown rather than clean.

If your routes ship their landmark as literal HTML and you only need per-page checks, axe-core in jsdom or html-validate is the better-supported choice.

## Install

```bash
bun add -d landmark-audit
```

## Run

Against a running server:

```bash
landmark-audit --base-url http://127.0.0.1:3000 --app-dir app
```

Dynamic routes need a representative URL. Put them in `landmark-audit.json`:

```json
{
  "appDir": "app",
  "samples": {
    "/posts/[slug]": ["/posts/hello"],
    "/docs/[...path]": ["/docs/getting-started"]
  },
  "unauditableMarkers": ["__NEXT_DEV_ERROR__"]
}
```

A dynamic page with no sample fails the run, so adding a route forces a decision about how it is audited. Or skip discovery and pass routes directly:

```bash
landmark-audit --base-url http://127.0.0.1:3000 --routes /,/about,/posts/hello
```

### Flags

| Flag | Default |
| --- | --- |
| `--base-url` | `LANDMARKS_BASE_URL` or `http://127.0.0.1:3000` |
| `--app-dir` | `app` when no routes are given |
| `--routes` | comma-separated, merged with discovered routes |
| `--config` | `landmark-audit.json` |
| `--main-id` | `main-content` |
| `--skip-link-class` | `skip-link` |
| `--concurrency` | `min(8, max(4, cores × 2))` |
| `--route-timeout-ms` | `30000` |
| `--json` | print every route result |

### What fails the run

- A rendered route with zero or several `<main>` elements, a `<main>` without the id, a nested `<main>`, or zero or several skip links. The skip link is matched by class, so a per-section "back to top" link to the same id does not count.
- A route that links to `#anchor` where no audited route renders that id. Judged across every route, not per page, because plenty of targets render only under a condition.
- A route that never answered inside the timeout. This is fatal rather than tolerated: a container that cannot reach the routes must not produce "0 violations" and a green gate.

A route that answered with an HTTP error, or with a page carrying one of `unauditableMarkers`, is reported as unauditable and warned about. It is not a violation. Failing the skip-link gate on an unrelated outage is how a check earns a reputation for crying wolf.

## Library

```ts
import { auditRoutes, collectAppRouterRoutes, inspectMainContentHtml, summarize } from "landmark-audit";

const routes = await collectAppRouterRoutes({ appDir: "app", samples });
const results = await auditRoutes({ baseUrl, routes, concurrency: 8 });
const report = summarize(results); // { violations, unauditable, timedOut, unresolvedAnchors, audited, exitCode }
```

`inspectMainContentHtml(html, { mainId, skipLinkClass })` and `inspectInPageAnchors(html)` are pure and take a string, for testing a shell component with `renderToStaticMarkup` without a server.

## Caveats

The flight-row patterns track the shape React 19 emits. A React release that changes the serialization will need a pattern update; the inspect tests pin the current shape so the break is visible. Streamed routes are checked for presence only, because React re-emits a segment's rows when a stream resumes, so counting would invent duplicates. Duplicate and nesting detection apply to routes that ship literal markup.

## License

MIT
