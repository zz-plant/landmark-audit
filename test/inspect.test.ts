import { describe, it } from "bun:test";
import assert from "node:assert/strict";

import { collectUnresolvedAnchors, inspectInPageAnchors, inspectMainContentHtml } from "../src/index.js";

const validHtml = `<!doctype html><html><body>
  <a class="skip-link" href="#main-content">Skip to content</a>
  <main id="main-content"><h1>Brief</h1></main>
</body></html>`;

describe("inspectMainContentHtml", () => {
  it("accepts one skip link targeting the only main landmark", () => {
    assert.deepEqual(inspectMainContentHtml(validHtml), {
      mainCount: 1,
      mainContentIdCount: 1,
      skipLinkCount: 1,
      nestedMain: false,
      issues: [],
    });
  });

  it("rejects missing, duplicate, and nested main landmarks", () => {
    const missing = inspectMainContentHtml('<a href="#main-content">Skip</a><main>Content</main>');
    assert.ok(missing.issues.some((issue) => /main-content/.test(issue)));

    const duplicate = inspectMainContentHtml(
      '<a class="skip-link" href="#main-content">Skip</a><main id="main-content"></main><main id="main-content"></main>',
    );
    assert.ok(duplicate.issues.some((issue) => /2 <main>/.test(issue)));
    assert.ok(duplicate.issues.some((issue) => /2 elements/.test(issue)));

    const nested = inspectMainContentHtml('<a class="skip-link" href="#main-content">Skip</a><main id="main-content"><main></main></main>');
    assert.equal(nested.nestedMain, true);
    assert.ok(nested.issues.some((issue) => /nested/.test(issue)));
  });

  it("counts the skip link by class, not every link to the id", () => {
    const html = validHtml + '<a href="#main-content">Back to top</a><a href="#main-content">Back to top</a>';
    assert.equal(inspectMainContentHtml(html).skipLinkCount, 1);
  });

  it("matches the skip link whatever the attribute order", () => {
    const html = '<a href="#main-content" class="nav skip-link">Skip</a><main id="main-content"></main>';
    assert.deepEqual(inspectMainContentHtml(html).issues, []);
  });

  it("reads a streamed route's landmark out of the flight payload", () => {
    const flight =
      '<main class="loading"></main>' +
      '<script>self.__next_f.push([1,"' +
      String.raw`[\"$\",\"a\",null,{\"className\":\"skip-link\",\"href\":\"#main-content\"}]` +
      String.raw`[\"$\",\"main\",null,{\"id\":\"main-content\",\"tabIndex\":-1}]` +
      '"])</script>';
    assert.deepEqual(inspectMainContentHtml(flight), {
      mainCount: 1,
      mainContentIdCount: 1,
      skipLinkCount: 1,
      nestedMain: false,
      issues: [],
    });
  });

  it("flags a streamed route with a landmark but no skip link", () => {
    const flight = String.raw`[\"$\",\"main\",null,{\"id\":\"main-content\"}]`;
    const result = inspectMainContentHtml(flight);
    assert.equal(result.skipLinkCount, 0);
    assert.match(result.issues[0] ?? "", /no skip link/);
  });

  it("does not let the flight payload excuse a duplicate in literal markup", () => {
    const html = validHtml + '<main id="main-content"></main>' + String.raw`[\"$\",\"main\",null,{\"id\":\"main-content\"}]`;
    assert.ok(inspectMainContentHtml(html).issues.some((issue) => /2 <main>/.test(issue)));
  });

  it("honours a custom id and skip-link class, escaping regex metacharacters", () => {
    const html = '<a class="jump.to" href="#content[1]">Skip</a><main id="content[1]"></main>';
    assert.deepEqual(inspectMainContentHtml(html, { mainId: "content[1]", skipLinkClass: "jump.to" }).issues, []);
    assert.ok(inspectMainContentHtml(html).issues.length > 0, "the default id does not match");
  });

  it("names an error shell instead of judging its landmark", () => {
    const result = inspectMainContentHtml("<div>__DEV_ERROR__</div>", { unauditableMarkers: ["__DEV_ERROR__"] });
    assert.ok(result.issues.some((issue) => /error shell/.test(issue)));
  });
});

describe("inspectInPageAnchors", () => {
  it("separates the ids a page carries from the anchors it links to", () => {
    assert.deepEqual(inspectInPageAnchors('<a href="#present">go</a><a href="#absent">go</a><div id="present"></div>'), {
      ids: ["present"],
      anchors: ["absent", "present"],
    });
  });

  it("reads an id out of the flight payload", () => {
    const html = '<a href="#main-content">skip</a>' + String.raw`\"id\":\"main-content\"`;
    assert.deepEqual(inspectInPageAnchors(html).ids, ["main-content"]);
  });

  it("leaves #top alone, and says nothing about another route's anchor", () => {
    assert.deepEqual(inspectInPageAnchors('<a href="#top">top</a>').anchors, []);
    assert.deepEqual(inspectInPageAnchors('<a href="/trust#glossary">glossary</a>').anchors, []);
  });
});

describe("collectUnresolvedAnchors", () => {
  it("passes an anchor another route renders, and fails one no route does", () => {
    const results = [
      { route: "/", anchorIds: ["weekly-call"], inPageAnchors: ["weekly-call", "elsewhere", "nowhere"] },
      { route: "/operate", anchorIds: ["elsewhere"], inPageAnchors: [] },
    ];
    assert.deepEqual(collectUnresolvedAnchors(results), [{ route: "/", missing: ["nowhere"] }]);
  });

  it("names every route that links to a missing id, in route order", () => {
    const results = [
      { route: "/b", anchorIds: [], inPageAnchors: ["gone"] },
      { route: "/a", anchorIds: [], inPageAnchors: ["gone"] },
    ];
    assert.deepEqual(collectUnresolvedAnchors(results), [
      { route: "/a", missing: ["gone"] },
      { route: "/b", missing: ["gone"] },
    ]);
  });

  it("says nothing when a route reported no anchors at all", () => {
    assert.deepEqual(collectUnresolvedAnchors([{ route: "/" }]), []);
  });
});
