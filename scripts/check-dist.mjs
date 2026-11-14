// Checks the built app in dist/ for problems a visitor would hit:
// a licence notice that names a missing worker file, a worker without its
// MPL notice, duplicate element ids, internal links that point at nothing,
// inline scripts that the page's CSP would block, and code that would fetch
// or load anything from another origin.
// Run after `vite build`. Exits 1 when it finds a problem.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const BASE = "/tools/VodSync/";
const WORKER = /^audio-sync-worker-[A-Za-z0-9_-]+\.js$/;
const MPL_BANNER = "MPL-2.0 source and notices: https://enzo.mutiso.ca/tools/VodSync/open-source.html";

// Calls that fetch or load a resource. Plain URLs in comments or <a href>
// navigation links are allowed; these destinations must stay same-origin.
const REMOTE_LOAD_IN_CODE =
	/\b(?:fetch|importScripts|import|sendBeacon|Worker|SharedWorker|WebSocket|EventSource)\s*\(\s*["'`](?:[a-z][a-z0-9+.-]*:)?\/\//gi;
const REMOTE_URL_IN_CSS = /url\(\s*["']?(?:[a-z][a-z0-9+.-]*:)?\/\//gi;
const LOADING_ATTRIBUTE =
	/<(script|link|img|video|audio|source|track|iframe|embed|object|form)\b[^>]*?\s(src|href|data|action)="([^"]*)"/gi;

function files(dir) {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? files(path) : [path];
	});
}

if (!existsSync(DIST)) {
	console.error("check-dist: dist/ does not exist. Run `npm run build` first.");
	process.exit(1);
}

const problems = [];
const all = files(DIST);
const relativePath = (file) => relative(DIST, file).replaceAll("\\", "/");

// 1. Exactly one worker, carrying the MPL notice, named by the licence page.
const workers = all.map(relativePath).filter((path) => {
	const [directory, name, extra] = path.split("/");
	return directory === "assets" && extra === undefined && WORKER.test(name);
});
const noticePath = join(DIST, "open-source.html");
if (workers.length !== 1) {
	problems.push(`expected one assets/audio-sync-worker-*.js, found ${workers.length}`);
} else {
	const worker = readFileSync(join(DIST, workers[0]), "utf8");
	if (!worker.includes(MPL_BANNER)) problems.push(`${workers[0]}: MPL notice banner is missing`);
	if (!existsSync(noticePath)) {
		problems.push("open-source.html is missing");
	} else {
		const named = [...readFileSync(noticePath, "utf8").matchAll(/assets\/audio-sync-worker-[A-Za-z0-9_-]+\.js/g)].map(
			(match) => match[0],
		);
		if (named.length === 0) problems.push("open-source.html does not name the worker asset");
		for (const name of named) {
			if (name !== workers[0]) problems.push(`open-source.html names ${name}, but the build emitted ${workers[0]}`);
		}
	}
}

// 2. HTML: unique ids, internal links resolve, nothing loads from elsewhere.
function resolvesInDist(url, page) {
	const path = decodeURIComponent(url.split("#")[0].split("?")[0]);
	if (path === "") return true;
	let target;
	if (path.startsWith(BASE)) target = join(DIST, path.slice(BASE.length));
	else if (path.startsWith("/")) return false;
	else target = join(DIST, page, "..", path);
	if (existsSync(target) && statSync(target).isDirectory()) target = join(target, "index.html");
	return existsSync(target);
}

const isExternal = (url) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url);
const sameDocument = (url) => /^(?:#|data:|blob:|mailto:)/i.test(url);
let pages = 0;
let links = 0;

for (const file of all.filter((path) => path.endsWith(".html"))) {
	pages += 1;
	const page = relativePath(file);
	const raw = readFileSync(file, "utf8");
	const html = raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (block) =>
		block.replace(/>[\s\S]*</, "><"),
	);

	const seen = new Set();
	for (const [, id] of html.matchAll(/\sid="([^"]+)"/g)) {
		if (seen.has(id)) problems.push(`${page}: duplicate id="${id}"`);
		seen.add(id);
	}

	const csp = raw.match(/http-equiv="Content-Security-Policy" content="([^"]*)"/)?.[1] ?? "";
	for (const [, body] of raw.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
		const hash = createHash("sha256").update(body).digest("base64");
		if (!csp.includes(`'sha256-${hash}'`)) problems.push(`${page}: CSP does not allow inline script sha256-${hash}`);
	}

	for (const [, tag, attribute, url] of html.matchAll(LOADING_ATTRIBUTE)) {
		if (isExternal(url)) problems.push(`${page}: <${tag} ${attribute}="${url}"> loads from another origin`);
	}

	for (const [, url] of html.matchAll(/<a\b[^>]*?\shref="([^"]*)"/gi)) {
		if (isExternal(url) || sameDocument(url)) continue;
		links += 1;
		if (!resolvesInDist(url, page)) problems.push(`${page}: href="${url}" points to nothing in dist/`);
	}
	for (const [, , , url] of html.matchAll(LOADING_ATTRIBUTE)) {
		if (isExternal(url) || sameDocument(url)) continue;
		links += 1;
		if (!resolvesInDist(url, page)) problems.push(`${page}: "${url}" points to nothing in dist/`);
	}
}

if (!readFileSync(join(DIST, "index.html"), "utf8").includes('http-equiv="Content-Security-Policy"')) {
	problems.push("index.html: Content-Security-Policy meta tag is missing");
}

// 3. Code and styles: no remote loads, and no duplicate ids inside one bundle's markup.
for (const file of all.filter((path) => /\.(?:js|css)$/.test(path))) {
	const name = relativePath(file);
	const source = readFileSync(file, "utf8");
	const pattern = name.endsWith(".css") ? REMOTE_URL_IN_CSS : REMOTE_LOAD_IN_CODE;
	for (const match of source.matchAll(pattern)) {
		problems.push(`${name}: remote load "${match[0]}"`);
	}
	if (name.endsWith(".js")) {
		const seen = new Set();
		for (const [, id] of source.matchAll(/\sid="([^"$]+)"/g)) {
			if (seen.has(id)) problems.push(`${name}: duplicate id="${id}" in rendered markup`);
			seen.add(id);
		}
	}
}

if (problems.length > 0) {
	console.error(problems.join("\n"));
	console.error(`check-dist: ${problems.length} problem(s)`);
	process.exit(1);
}

console.log(
	`check-dist: ${pages} pages, ${links} internal links, worker ${workers[0]}, 0 problems`,
);
