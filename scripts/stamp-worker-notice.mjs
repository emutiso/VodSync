// open-source.html names the shipped MediaBunny worker, whose hashed filename
// changes with each build. Run after `vite build` to stamp the emitted name
// into dist/open-source.html. Exits 1 when the worker or the notice is missing.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const NAMED_WORKER = /assets\/audio-sync-worker-[A-Za-z0-9_-]+\.js/g;

const workers = readdirSync(new URL("assets/", `file://${DIST}`)).filter((name) =>
	/^audio-sync-worker-[A-Za-z0-9_-]+\.js$/.test(name),
);
if (workers.length !== 1) {
	console.error(`stamp-worker-notice: expected one audio-sync worker, found ${workers.length}`);
	process.exit(1);
}

const notice = `${DIST}open-source.html`;
const html = readFileSync(notice, "utf8");
if (!NAMED_WORKER.test(html)) {
	console.error("stamp-worker-notice: open-source.html does not name the worker asset");
	process.exit(1);
}
writeFileSync(notice, html.replace(NAMED_WORKER, `assets/${workers[0]}`));
console.log(`stamp-worker-notice: open-source.html names assets/${workers[0]}`);
