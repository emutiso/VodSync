import "./style.css";
import { SyncPlayer, type SyncPlayerCallbacks } from "./sync-player";

type LauncherTheme = "light" | "dark";

const themeStorageKey = "vodsync-theme";

function preferredLauncherTheme(): LauncherTheme {
	try {
		const stored = localStorage.getItem(themeStorageKey);
		if (stored === "light" || stored === "dark") return stored;
	} catch {
		// Storage can be unavailable in restrictive browser contexts.
	}
	return matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function setLauncherTheme(theme: LauncherTheme) {
	document.documentElement.dataset.theme = theme;
	const toggle = document.querySelector<HTMLButtonElement>("#theme-toggle");
	if (!toggle) return;
	const nextTheme = theme === "dark" ? "light" : "dark";
	toggle.setAttribute("aria-label", `Switch to ${nextTheme} mode`);
	toggle.title = `Switch to ${nextTheme} mode`;
}

setLauncherTheme(preferredLauncherTheme());

const app = document.querySelector<HTMLElement>("#app");
if (!app) throw new Error("Missing app root");

const appHome = import.meta.env.BASE_URL;

app.innerHTML = `
  <header class="app-header">
    <a class="brand-lockup" href="${appHome}" aria-label="VodSync home">
      <span class="brand-mark" aria-hidden="true">VS</span>
      <strong>VodSync</strong>
    </a>
    <div class="header-actions">
      <a class="tools-link" href="/tools" aria-label="Back to Enzo Mutiso's tools">
        <span aria-hidden="true">←</span>
        <span>Enzo's tools</span>
      </a>
      <button id="theme-toggle" class="theme-toggle" type="button" aria-label="Toggle color theme">
        <svg class="theme-icon theme-icon-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>
        <svg class="theme-icon theme-icon-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41"/></svg>
      </button>
    </div>
  </header>

  <section id="launcher-panel" class="launcher-panel" aria-labelledby="inputs-heading">
    <div class="import-workflow">
      <div class="import-intro">
        <h1 id="inputs-heading">Review every angle on one timeline.</h1>
        <p class="intro">Bring together 2–6 recordings from the same match. VodSync aligns them for one shared, local playback session.</p>
        <p class="local-assurance"><strong>Your recordings stay on this device.</strong><span>No upload, account, or media copy.</span></p>
        <p class="public-notices">Open source under Apache 2.0. MediaBunny remains MPL 2.0. <a href="${appHome}open-source.html">Open-source notices and corresponding source</a>.</p>
      </div>
      <div id="file-drop-zone" class="file-drop-zone" aria-labelledby="drop-heading">
        <div class="drop-prompt">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 16.2V6.8L7.4 10.4 6 9l6-6 6 6-1.4 1.4L13 6.8v9.4h-2ZM5 21a2 2 0 0 1-2-2v-4h2v4h14v-4h2v4a2 2 0 0 1-2 2H5Z"/></svg>
          <h2 id="drop-heading">Drop your POV recordings here</h2>
          <p>MP4, WebM, or MKV · 2–6 videos</p>
        </div>
        <ul id="file-selection-meta" class="file-list" aria-label="Selected recordings"></ul>
        <div class="import-actions">
          <label class="file-picker-action">
            <span id="file-picker-label">Choose videos</span>
            <input id="file-picker" type="file" multiple accept="video/mp4,video/webm,video/matroska,video/x-matroska,.mp4,.webm,.mkv" />
          </label>
          <button id="sync-open" class="primary-action" type="button" disabled>Start Sync</button>
        </div>
        <p id="status" class="launcher-status" role="status" aria-live="polite">Waiting for 2–6 files.</p>
      </div>
    </div>
  </section>

  <section id="sync-panel" class="sync-panel" aria-label="Synchronized review" hidden>
    <div id="sync-root"></div>
  </section>
`;

function requiredElement<T extends Element>(selector: string) {
	const element = document.querySelector<T>(selector);
	if (!element) throw new Error(`Missing required element: ${selector}`);
	return element;
}

const filePicker = requiredElement<HTMLInputElement>("#file-picker");
const filePickerLabel = requiredElement<HTMLElement>("#file-picker-label");
const fileDropZone = requiredElement<HTMLElement>("#file-drop-zone");
const fileSelectionMetadata = requiredElement<HTMLElement>(
	"#file-selection-meta",
);
const syncOpenButton = requiredElement<HTMLButtonElement>("#sync-open");
const launcherPanel = requiredElement<HTMLElement>("#launcher-panel");
const syncPanel = requiredElement<HTMLElement>("#sync-panel");
const syncRoot = requiredElement<HTMLElement>("#sync-root");
const status = requiredElement<HTMLElement>("#status");
const themeToggle = requiredElement<HTMLButtonElement>("#theme-toggle");

setLauncherTheme(preferredLauncherTheme());
themeToggle.addEventListener("click", () => {
	const nextTheme: LauncherTheme =
		document.documentElement.dataset.theme === "dark" ? "light" : "dark";
	setLauncherTheme(nextTheme);
	try {
		localStorage.setItem(themeStorageKey, nextTheme);
	} catch {
		// The selected theme still applies for the current page.
	}
});

let syncPlayer: SyncPlayer | null = null;
let syncOpening = false;
let selectedRecordings: File[] = [];

function selectedFiles() {
	return [...selectedRecordings];
}

function formatBytes(bytes: number) {
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let value = bytes / 1024;
	let unitIndex = 0;
	while (value >= 1024 && unitIndex < units.length - 1) {
		value /= 1024;
		unitIndex += 1;
	}
	return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function updateReadyState() {
	const count = selectedFiles().length;
	const ready = count >= 2 && count <= 6;
	const selectionLocked = count >= 6 || syncPlayer !== null || syncOpening;
	filePicker.disabled = selectionLocked;
	fileDropZone.dataset.acceptingFiles = String(!selectionLocked);
	syncOpenButton.disabled = !ready || syncPlayer !== null || syncOpening;
	syncOpenButton.textContent = syncOpening ? "Starting Sync…" : "Start Sync";
}

function updateFileMetadata() {
	const files = selectedFiles();
	fileSelectionMetadata.replaceChildren();
	fileDropZone.dataset.hasFiles = String(files.length > 0);
	filePickerLabel.textContent =
		files.length === 0
			? "Choose videos"
			: files.length < 6
				? "Add more videos"
				: "6 video maximum";

	if (files.length === 0) {
		const empty = document.createElement("li");
		empty.className = "file-list-empty";
		empty.textContent = "No recordings added yet.";
		fileSelectionMetadata.append(empty);
		return;
	}

	for (const [index, file] of files.entries()) {
		const item = document.createElement("li");
		item.className = "file-list-item";
		const number = document.createElement("span");
		number.className = "file-number";
		number.textContent = String(index + 1);
		const details = document.createElement("span");
		details.className = "file-details";
		const name = document.createElement("strong");
		name.textContent = file.name;
		const metadata = document.createElement("span");
		metadata.textContent = `${formatBytes(file.size)} · ${file.type || "video"}`;
		details.append(name, metadata);
		const remove = document.createElement("button");
		remove.className = "file-remove";
		remove.type = "button";
		remove.textContent = "Remove";
		remove.setAttribute("aria-label", `Remove ${file.name}`);
		remove.addEventListener("click", () => {
			selectedRecordings.splice(index, 1);
			updateSelectionState();
		});
		item.append(number, details, remove);
		fileSelectionMetadata.append(item);
	}
}

type StatusTone = "neutral" | "success" | "warning" | "error";

function setStatus(message: string, tone: StatusTone = "neutral") {
	status.textContent = message;
	status.dataset.tone = tone;
}

function updateSelectionState() {
	updateFileMetadata();
	updateReadyState();
	const count = selectedFiles().length;
	setStatus(
		count >= 2 && count <= 6
			? `${count} recordings ready. Start Sync when your set is complete.`
			: count === 1
				? "Add at least one more recording to sync."
				: "Add 2–6 recordings to begin.",
	);
}

async function closeSyncPlayer(
	message = "Synchronized player closed and resources released.",
) {
	const player = syncPlayer;
	if (!player) return;
	syncPlayer = null;
	await player.destroy();
	syncPanel.hidden = true;
	delete document.documentElement.dataset.workspace;
	updateReadyState();
	setStatus(message, "success");
}

async function openSyncPlayer() {
	if (syncPlayer) {
		await closeSyncPlayer();
		return;
	}

	const files = selectedFiles();
	if (files.length < 2 || files.length > 6) return;

	syncOpening = true;
	filePicker.disabled = true;
	updateReadyState();
	syncPanel.hidden = false;
	document.documentElement.dataset.workspace = "active";
	const callbacks: SyncPlayerCallbacks = {
		onStatus: (message, tone) => setStatus(message, tone),
	};
	const player = new SyncPlayer(syncRoot, files, callbacks);
	syncPlayer = player;

	try {
		await player.open();
		syncPanel.scrollIntoView({
			behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
				? "auto"
				: "smooth",
			block: "start",
		});
	} catch (error) {
		await player.destroy();
		syncPlayer = null;
		syncPanel.hidden = true;
		delete document.documentElement.dataset.workspace;
		setStatus(
			`Could not open synchronized player: ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
	} finally {
		syncOpening = false;
		updateReadyState();
	}
}

async function addSelectedFiles(incoming: readonly File[]) {
	const supported = incoming.filter(
		(file) =>
			file.type.startsWith("video/") || /\.(mp4|webm|mkv)$/iu.test(file.name),
	);
	const available = Math.max(0, 6 - selectedRecordings.length);
	const added = supported.slice(0, available);

	if (syncPlayer && added.length > 0) {
		await closeSyncPlayer(
			"File selection changed; prior player resources released.",
		);
	}

	selectedRecordings.push(...added);
	updateSelectionState();

	const unsupportedCount = incoming.length - supported.length;
	const overLimitCount = supported.length - added.length;
	if (unsupportedCount > 0 || overLimitCount > 0) {
		const reasons = [
			unsupportedCount > 0
				? `${unsupportedCount} unsupported ${unsupportedCount === 1 ? "file was" : "files were"} skipped`
				: "",
			overLimitCount > 0
				? `${overLimitCount} ${overLimitCount === 1 ? "video was" : "videos were"} skipped because a session supports up to six`
				: "",
		].filter(Boolean);
		setStatus(`${reasons.join("; ")}.`, "warning");
	}
}

syncOpenButton.addEventListener("click", () => void openSyncPlayer());
syncRoot.addEventListener("sync-close-requested", () => void closeSyncPlayer());
filePicker.addEventListener("change", () => {
	const incoming = [...(filePicker.files ?? [])];
	filePicker.value = "";
	void addSelectedFiles(incoming);
});
fileDropZone.addEventListener("dragover", (event) => {
	if (filePicker.disabled) return;
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
	fileDropZone.dataset.dragging = "true";
});
fileDropZone.addEventListener("dragleave", (event) => {
	if (
		event.relatedTarget instanceof Node &&
		fileDropZone.contains(event.relatedTarget)
	)
		return;
	delete fileDropZone.dataset.dragging;
});
fileDropZone.addEventListener("drop", (event) => {
	delete fileDropZone.dataset.dragging;
	if (filePicker.disabled) return;
	event.preventDefault();
	void addSelectedFiles([...(event.dataTransfer?.files ?? [])]);
});

window.addEventListener("pagehide", () => {
	void syncPlayer?.destroy();
});

launcherPanel.setAttribute("aria-busy", "false");
updateSelectionState();
