import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { compile } from "@tailwindcss/node";
import { Scanner } from "@tailwindcss/oxide";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const bundled = await build({ entryPoints: [resolve(root, "tests/browser/enquiries-entry.tsx")], bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' }, tsconfig: resolve(root, "tsconfig.json"),
  // Shared UI imports Next Link, although the inbox has no routed links. The
  // fixture supplies anchor semantics without initializing a Next router.
  plugins: [{ name: "fixture-link", setup(builder) {
    builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "fixture-link", namespace: "fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: 'import {createElement} from "react"; export default function Link(props) { return createElement("a", props); }', loader: "js", resolveDir: root }));
  } }],
});
const cssPath = resolve(root, "src/app/globals.css");
const compiler = await compile(await readFile(cssPath, "utf8"), { base: dirname(cssPath), from: cssPath, onDependency() {} });
const scanner = new Scanner({ sources: [{ base: root, pattern: "src/**/*.{ts,tsx}", negated: false }, { base: root, pattern: "tests/browser/enquiries-entry.tsx", negated: false }] });
const css = compiler.build(scanner.scan());
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Safar enquiry UI fixture</title><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>';
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1:3219").pathname;
  const value = path === "/fixture.js" ? ["text/javascript", bundled.outputFiles[0].text] : path === "/fixture.css" ? ["text/css", css] : path === "/" || path === "/enquiries" ? ["text/html", html] : null;
  response.writeHead(value ? 200 : 404, { "Content-Type": value?.[0] ?? "text/plain", "Cache-Control": "no-store" });
  response.end(value?.[1] ?? "Synthetic fixture: this endpoint must be intercepted by the test.");
});
server.listen(3219, "127.0.0.1", () => console.log("Synthetic enquiry component fixture listening on 127.0.0.1:3219"));
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => server.close(() => process.exit(0)));
