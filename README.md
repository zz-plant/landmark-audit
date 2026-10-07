# landmark-audit

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Check every page of a running web app for a working "skip to content" link. Each page needs exactly one `<main id="main-content">` element and exactly one skip link pointing at it. The tool also finds in-page links such as `href="#pricing"` whose target doesn't exist on any page.

```console
$ landmark-audit --base-url http://127.0.0.1:3000 --routes /,/streamed,/dup,/dead,/down
Auditing 5 routes at http://127.0.0.1:3000 for main-landmark ownership.

✗ /dup  (http://127.0.0.1:3000/dup)
    Expected exactly 1 <main>; found 2 <main> elements.
    Expected exactly 1 id="main-content"; found 2 elements.

✗ /dead
    Links to #nowhere, which no audited route renders.

⚠ 1 route(s) could not be audited; they did not render:
    /down  (HTTP 500)
  Landmark coverage for these routes is unknown, not clean.
```

## Contents

- [Background](#background)
- [Why this tool](#why-this-tool)
- [Install](#install)
- [Quick start](#quick-start)
- [What it checks](#what-it-checks)
- [Configuration](#configuration)
- [CLI reference](#cli-reference)
- [Using it as a library](#using-it-as-a-library)
- [How it compares](#how-it-compares)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## Background

Most sites repeat the same header and navigation on every page. A *skip link* is a link at the very top of the page, usually hidden until it gets keyboard focus, that jumps past all of that to the page's main content. Keyboard and screen-reader users rely on it. Without it, they have to tab through the whole navigation on every page.

The skip link points at an id, and the page's `<main>` element carries that id:

```html
<a class="skip-link" href="#main-content">Skip to content</a>
<nav>…</nav>
<main id="main-content">…</main>
```

The `<main>` element is a *landmark*: assistive technology lists landmarks so users can jump between page regions. A page should have exactly one `<main>`.

This setup breaks quietly. A layout and a page component can both render `<main>`, a loading screen can render one without the id, or a refactor can drop the id. Nothing fails at build time, type checks pass, and the page looks the same. Only keyboard and screen-reader users notice.

## Why this tool

The reliable way to check this is to look at each page as the server actually sends it, since layouts and page components combine at that point. Doing that by hand for every page is tedious, so this tool fetches each route and checks the result.

It also handles one case that HTML-only checkers miss. In apps built with React Server Components, as in the Next.js App Router, part of a page can arrive as data for React to render in the browser rather than as HTML. That data is called the *flight payload*, and it is embedded in `<script>` tags. When the `<main>` element arrives that way, a checker that only looks for `<main>` in the HTML reports it as missing. This tool reads the flight payload as well. In the app it was extracted from, HTML-only scanning wrongly flagged about half of the pages.

No browser is needed. It runs anywhere your server runs, including a CI build container.

## Install

> [!NOTE]
> This package is not on npm yet. Until the first release, install it from GitHub with npm, which builds it during install:
>
> ```bash
> npm install --save-dev github:zz-plant/landmark-audit
> ```
>
> Bun skips build steps for packages installed from GitHub, so the command-line tool won't be available that way. Use npm for now.

After the first release:

```bash
npm install --save-dev landmark-audit
# or
bun add --dev landmark-audit
```

Requires Node.js 20 or later, or Bun 1.1 or later.

## Quick start

**1. Start your app.** The tool checks a running server and doesn't start one for you.

```bash
npm run dev
```

**2. Run the audit.**

For a Next.js App Router project, point the tool at your `app` folder and it finds every page:

```bash
npx landmark-audit --base-url http://127.0.0.1:3000 --app-dir app
```

For any other framework, list the pages to check:

```bash
npx landmark-audit --base-url http://127.0.0.1:3000 --routes /,/about,/blog/hello-world
```

**3. Give dynamic pages a sample URL.** A page file such as `app/blog/[slug]/page.tsx` has no single URL, so the tool needs an example of one. Create `landmark-audit.json`:

```json
{
  "samples": {
    "/blog/[slug]": ["/blog/hello-world"]
  }
}
```

The run fails if a dynamic page has no sample. That way, adding a new kind of page forces you to decide how it is checked.

**4. Add it to CI.** Start the server, then run the audit as a check:

```json
{
  "scripts": {
    "check:landmarks": "landmark-audit --app-dir app"
  }
}
```

## What it checks

**Failures.** These exit with code `1`:

| Problem | Example |
| --- | --- |
| No `<main>` on a page, or more than one | A layout and a page both render `<main>` |
| `<main>` is missing the id | `<main>` instead of `<main id="main-content">` |
| One `<main>` inside another | Nested landmarks |
| No skip link, or more than one | The link is counted by its `skip-link` class, so "Back to top" links to the same id don't count |
| An in-page link with no target anywhere | `href="#faq"` where no page has an element with `id="faq"` |
| A page that never responds | No response within the timeout |

In-page links are checked across all pages together. A target that appears only on some pages, or only in some situations, passes. Only a target that appears on no page fails.

A page that never responds fails the run. Otherwise a CI machine that can't reach the server would report zero problems and pass.

**Warnings.** These don't fail the run:

| Situation | Why it's only a warning |
| --- | --- |
| The page returned an HTTP error | The page didn't render, so whether it has a skip link is unknown. Failing would blame an unrelated outage. |
| The page contains one of your `unauditableMarkers` | Same reason. Use this for your framework's development error screen. |

## Configuration

Settings come from `landmark-audit.json` in the current folder, or the file passed with `--config`. Every field is optional. Command-line flags override the file.

```json
{
  "appDir": "app",
  "samples": {
    "/blog/[slug]": ["/blog/hello-world"],
    "/docs/[...path]": ["/docs/getting-started"]
  },
  "routes": ["/extra-page"],
  "mainId": "main-content",
  "skipLinkClass": "skip-link",
  "unauditableMarkers": ["__NEXT_DEV_ERROR__"]
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `appDir` | `app`, when no routes are given | Next.js App Router folder to scan for pages. Route groups like `(marketing)` and parallel slots like `@modal` are handled. `api` folders are skipped. |
| `samples` | `{}` | One or more example URLs for each dynamic page pattern. |
| `routes` | `[]` | Extra pages to check, added to any discovered pages. |
| `mainId` | `main-content` | The id the `<main>` element must carry and the skip link must point at. |
| `skipLinkClass` | `skip-link` | The class that marks the skip link. |
| `unauditableMarkers` | `[]` | Text whose presence means the server returned an error screen instead of the page. |

## CLI reference

```text
landmark-audit [options]

  --base-url <url>          Where the app is running. Default: $LANDMARKS_BASE_URL or http://127.0.0.1:3000
  --app-dir <path>          Find pages in a Next.js App Router folder
  --routes <a,b,c>          Comma-separated pages to check, added to any discovered pages
  --config <path>           Config file. Default: landmark-audit.json
  --main-id <id>            Overrides mainId
  --skip-link-class <name>  Overrides skipLinkClass
  --concurrency <n>         Pages fetched at once. Default: twice the CPU cores, between 4 and 8
  --route-timeout-ms <ms>   How long to wait for each page. Default: 30000
  --json                    Print the full result for every page as JSON
```

| Exit code | Meaning |
| --- | --- |
| `0` | Every page that rendered passed, and every page responded. |
| `1` | At least one failure from [What it checks](#what-it-checks). |
| `2` | Bad arguments, nothing to check, or the server isn't reachable. |

Any HTTP response from the base URL counts as "server is up", including an error status. A server that is partly broken still renders pages to check.

## Using it as a library

```ts
import { auditRoutes, collectAppRouterRoutes, summarize } from "landmark-audit";

const routes = await collectAppRouterRoutes({
  appDir: "app",
  samples: { "/blog/[slug]": ["/blog/hello-world"] },
});

const results = await auditRoutes({ baseUrl: "http://127.0.0.1:3000", routes });
const report = summarize(results);

if (report.exitCode !== 0) {
  console.error(report.violations, report.unresolvedAnchors, report.timedOut);
}
```

The page checks also work on an HTML string without a server. This is useful in a unit test for a layout component:

```ts
import { renderToStaticMarkup } from "react-dom/server";
import { inspectMainContentHtml } from "landmark-audit";

const html = renderToStaticMarkup(<Layout><h1>Hello</h1></Layout>);
expect(inspectMainContentHtml(html).issues).toEqual([]);
```

| Export | Purpose |
| --- | --- |
| `auditRoutes(options)` | Fetches each page and checks it. Returns one result per page. |
| `summarize(results)` | Sorts results into `violations`, `unauditable`, `timedOut`, and `unresolvedAnchors`, and gives an `exitCode`. |
| `collectAppRouterRoutes(options)` | Lists the pages in a Next.js App Router folder. |
| `inspectMainContentHtml(html, options?)` | Checks one HTML string for the landmark and skip link. |
| `inspectInPageAnchors(html)` | Lists the ids a page contains and the `#` links it makes. |
| `collectUnresolvedAnchors(results)` | Finds `#` links whose target appears on no page. |

## How it compares

[axe-core](https://github.com/dequelabs/axe-core) and [html-validate](https://html-validate.org/) are mature, widely used accessibility tools, and they check far more than this one does. Both work on one page at a time.

We ran axe-core in jsdom, without a browser, against sample pages:

| Problem | axe-core | html-validate | landmark-audit |
| --- | --- | --- | --- |
| Two `<main>` elements | Yes | Yes, `no-multiple-main` | Yes |
| `<main>` inside `<main>` | Yes | Yes, as two `<main>` elements | Yes |
| No `<main>` at all | Undecided: "needs review" on every page, including correct ones | No | Yes |
| Skip link pointing at a missing id | Not flagged in our test | No, its reference rule skips `#` links | Yes |
| `<main>` delivered in the flight payload | No | No | Yes |
| Every page of the app in one run | No | No | Yes |
| `#` links checked across pages | No | No | Yes |

If your pages send their `<main>` as plain HTML and you want broad accessibility coverage, use axe-core. You can run it alongside this tool.

## Limitations

- **The flight payload format belongs to React.** The patterns match what React 19 sends. A future React release could change it, and this tool would then need an update. The tests pin the current format so a break shows up as a failing test.
- **Streamed pages get a lighter check.** React can send the same piece of a page more than once while streaming, so counting would report false duplicates. For a page whose `<main>` arrives only in the flight payload, the tool checks that the landmark and the skip link exist, not how many there are.
- **Automatic page discovery is Next.js App Router only.** For other frameworks, list pages with `--routes` or `routes`.
- **It doesn't start your server.** Start it before the audit runs.

## Development

```bash
git clone https://github.com/zz-plant/landmark-audit.git
cd landmark-audit
bun install
bun run check   # type check and tests
bun run build   # compile to dist/
```

## License

[MIT](LICENSE)
