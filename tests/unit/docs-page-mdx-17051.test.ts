import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";

const root = fileURLToPath(new URL("../../", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "omniroute-docs-mdx-17051-"));
const originalDataDir = process.env.DATA_DIR;
const originalMemoryDir = process.env.MEMORY_STATIC_CACHE_DIR;
const originalFetch = globalThis.fetch;

process.env.DATA_DIR = path.join(scratch, "data");
process.env.MEMORY_STATIC_CACHE_DIR = path.join(scratch, "memory");
globalThis.fetch = async () => {
  throw new Error("Unexpected network request while rendering documentation");
};

// Fixture boundaries: generated MDX content, Next request context and layout.
// The Page, link resolver and fumadocs-ui/mdx exports/components remain real.
const fixtures: Record<string, string> = {
  "@/lib/source": `
    import { createElement as h } from "react";
    export const source = { getPage(slug) {
      return {
        file: { path: "architecture/ARCHITECTURE.md" },
        data: { title: "Architecture", toc: [], body({ components }) {
          if (slug[1] === "plain") return h("p", null, "Plain documentation content.");
          return h("p", null, "See ",
            h(components.a, { href: "../routing/AUTO-COMBO.md#strategies" }, "Auto Combo"));
        } }
      };
    } };
  `,
  "next/headers": 'export const cookies = () => ({ get: () => ({ value: "en" }) });',
  "next/navigation": 'export const notFound = () => { throw new Error("Not found"); };',
  "next-intl/server": 'export const getTranslations = async () => () => "Docs";',
  "fumadocs-ui/layouts/docs/page": `
    import { createElement as h } from "react";
    export const DocsPage = ({ children }) => h("main", null, children);
    export const DocsBody = ({ children }) => h("article", null, children);
  `,
};

let Page: (props: { params: Promise<{ slug: string[] }> }) => Promise<ReactElement>;

before(async () => {
  const outfile = path.join(scratch, "docs-page.mjs");
  // Native ESM is essential here: Vitest's default dependency interop invents
  // named exports from a default object and can hide the namespace-import bug.
  await build({
    entryPoints: [path.join(root, "src/app/docs/[...slug]/page.tsx")],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    jsx: "automatic",
    tsconfig: path.join(root, "tsconfig.json"),
    plugins: [
      {
        name: "docs-render-boundaries",
        setup(builder) {
          builder.onResolve({ filter: /.*/ }, (args) => {
            const fixture = args.path === "../../../lib/source" ? "@/lib/source" : args.path;
            if (Object.hasOwn(fixtures, fixture))
              return { path: fixture, namespace: "docs-fixture" };
            if (
              args.path.startsWith("@/") ||
              args.path.startsWith(".") ||
              path.isAbsolute(args.path)
            ) {
              return undefined;
            }
            const resolved = import.meta.resolve(args.path);
            return {
              path: resolved.startsWith("file:") ? fileURLToPath(resolved) : resolved,
              external: true,
            };
          });
          builder.onLoad({ filter: /.*/, namespace: "docs-fixture" }, (args) => ({
            contents: fixtures[args.path],
            loader: "js",
          }));
        },
      },
    ],
  });
  ({ default: Page } = await import(pathToFileURL(outfile).href));
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalMemoryDir === undefined) delete process.env.MEMORY_STATIC_CACHE_DIR;
  else process.env.MEMORY_STATIC_CACHE_DIR = originalMemoryDir;
  rmSync(scratch, { recursive: true, force: true });
});

test("the real docs page renders an MDX link with its resolved documentation URL", async () => {
  const page = await Page({ params: Promise.resolve({ slug: ["architecture", "linked"] }) });
  let html = "";
  assert.doesNotThrow(() => {
    html = renderToStaticMarkup(page);
  });
  assert.match(html, /<a[^>]+href="\/docs\/routing\/AUTO-COMBO#strategies"[^>]*>Auto Combo<\/a>/);
});

test("the real docs page continues to render content without links", async () => {
  const page = await Page({ params: Promise.resolve({ slug: ["architecture", "plain"] }) });
  assert.match(
    renderToStaticMarkup(page),
    /<article><p>Plain documentation content\.<\/p><\/article>/
  );
});
