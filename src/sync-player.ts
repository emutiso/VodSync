import { candidatePlaybackOffsetUs } from "./audio-sync";
import { AudioSyncSession } from "./audio-sync-session";
import { cleanupVideos, type PreparedVideo, prepareVideos } from "./playback";
import type { AudioSyncResult } from "./sync-types";
import {
	isLocalTimeCovered,
	localToReferenceUs,
	microsecondsToSeconds,
	referenceToLocalUs,
	secondsToMicroseconds,
} from "./timeline";

const SEEK_TIMEOUT_MS = 8_000;
const DRIFT_JITTER_US = 40_000;
const DRIFT_SEEK_US = 250_000;
const CORRECTION_COOLDOWN_MS = 750;
const MAXIMUM_CORRECTION_SEEKS_PER_POV_30_SECONDS = 12;

type SyncStatusTone = "neutral" | "success" | "warning" | "error";
type GapState = "covered" | "pre-start" | "post-end";

export type SyncPlayerCallbacks = {
	onStatus: (message: string, tone: SyncStatusTone) => void;
};

type SyncElements = {
	stage: HTMLElement;
	aligning: HTMLElement;
	player: HTMLElement;
	status: HTMLElement;
	videos: HTMLElement;
	focusResizer: HTMLElement;
	cards: HTMLElement[];
	slots: HTMLElement[];
	gaps: HTMLElement[];
	localTimes: HTMLElement[];
	controls: HTMLElement;
	play: HTMLButtonElement;
	timeline: HTMLElement;
	seek: HTMLInputElement;
	referenceTime: HTMLElement;
	durationTime: HTMLElement;
	speed: HTMLSelectElement;
	volume: HTMLInputElement;
	mute: HTMLButtonElement;
	layout: HTMLButtonElement;
	fullscreen: HTMLButtonElement;
	help: HTMLButtonElement;
	helpDialog: HTMLDialogElement;
	helpClose: HTMLButtonElement;
	timingOpen: HTMLButtonElement;
	timingDialog: HTMLDialogElement;
	timingClose: HTMLButtonElement;
	timingNotice: HTMLElement;
	offsetTarget: HTMLSelectElement;
	offset: HTMLInputElement;
	offsetApply: HTMLButtonElement;
	offsetValue: HTMLElement;
	correctionValue: HTMLElement;
	nudgeButtons: HTMLButtonElement[];
	reset: HTMLButtonElement;
	restore: HTMLButtonElement;
	accept: HTMLButtonElement;
	reject: HTMLButtonElement;
	auto: HTMLButtonElement;
	autoProgress: HTMLElement;
	autoMeter: HTMLProgressElement;
	close: HTMLButtonElement;
	staging: HTMLElement;
};

function requiredElement<T extends Element>(
	root: ParentNode,
	selector: string,
) {
	const element = root.querySelector<T>(selector);
	if (!element)
		throw new Error(`Missing synchronized-player element: ${selector}`);
	return element;
}

function formatTime(microseconds: number) {
	const sign = microseconds < 0 ? "−" : "";
	const totalMilliseconds = Math.round(Math.abs(microseconds) / 1_000);
	const milliseconds = totalMilliseconds % 1_000;
	const totalSeconds = Math.floor(totalMilliseconds / 1_000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function formatOffset(microseconds: number) {
	const sign = microseconds > 0 ? "+" : microseconds < 0 ? "−" : "";
	return `${sign}${(Math.abs(microseconds) / 1_000_000).toFixed(3)} s`;
}

function formatPlayerTime(microseconds: number) {
	const sign = microseconds < 0 ? "−" : "";
	const totalSeconds = Math.floor(Math.abs(microseconds) / 1_000_000);
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	return hours > 0
		? `${sign}${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${sign}${minutes}:${String(seconds).padStart(2, "0")}`;
}

const PLAYER_ICONS = {
	play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.8v14.4L19 12 7 4.8Z"/></svg>',
	pause:
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5h4v14H6V5Zm8 0h4v14h-4V5Z"/></svg>',
	volume:
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Zm11.4-.8v7.6a5 5 0 0 0 0-7.6Zm0-3v2.1a7 7 0 0 1 0 9.4v2.1a9 9 0 0 0 0-13.6Z"/></svg>',
	muted:
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9v6h4l5 4V5L8 9H4Zm12.4.1L15 10.5l1.6 1.5-1.6 1.5 1.4 1.4 1.6-1.5 1.6 1.5 1.4-1.4-1.6-1.5 1.6-1.5-1.4-1.4-1.6 1.5-1.6-1.5Z"/></svg>',
	focus:
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4V5Zm2 2v10h12V7H6Zm1 1h7v8H7V8Zm8 0h2v2h-2V8Zm0 3h2v2h-2v-2Zm0 3h2v2h-2v-2Z"/></svg>',
	grid: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v7H4V4Zm9 0h7v7h-7V4ZM4 13h7v7H4v-7Zm9 0h7v7h-7v-7Z"/></svg>',
	fullscreen:
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v2H6v5H4V4Zm9 0h7v7h-2V6h-5V4ZM4 13h2v5h5v2H4v-7Zm14 0h2v7h-7v-2h5v-5Z"/></svg>',
	"fullscreen-exit":
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h2v7H4V9h5V4Zm4 0h2v5h5v2h-7V4ZM4 13h7v7H9v-5H4v-2Zm9 0h7v2h-5v5h-2v-7Z"/></svg>',
	back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10.6 5-7 7 7 7 1.4-1.4L7.4 13H21v-2H7.4L12 6.4 10.6 5Z"/></svg>',
	timing:
		'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h7v2H4V6Zm11 0h5v2h-5V6Zm-2-2h2v6h-2V4ZM4 16h4v2H4v-2Zm8 0h8v2h-8v-2Zm-4-2h2v6H8v-6Z"/></svg>',
	help: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 17h2v2h-2v-2Zm1-14a8 8 0 1 0 0 16v-2a6 6 0 1 1 6-6 6 6 0 0 1-6 6v2a8 8 0 0 0 0-16Zm0 4a3.5 3.5 0 0 0-3.5 3.5h2A1.5 1.5 0 1 1 12 12h-1v3h2v-1.2A3.5 3.5 0 0 0 12 7Z"/></svg>',
} as const;

type PlayerIcon = keyof typeof PLAYER_ICONS;

function setIconButton(
	button: HTMLButtonElement,
	label: string,
	icon: PlayerIcon,
) {
	button.setAttribute("aria-label", label);
	button.title = label;
	button.innerHTML = PLAYER_ICONS[icon];
}

function waitForSeek(element: HTMLMediaElement, targetSeconds: number) {
	const safeTarget = Math.min(
		Math.max(0, targetSeconds),
		Math.max(0, element.duration - 0.001),
	);
	if (Math.abs(element.currentTime - safeTarget) < 0.004)
		return Promise.resolve();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const cleanup = () => {
		window.clearTimeout(timeout);
		element.removeEventListener("seeked", onSeeked);
		element.removeEventListener("error", onError);
	};
	const onSeeked = () => {
		cleanup();
		resolve();
	};
	const onError = () => {
		cleanup();
		reject(new Error(element.error?.message ?? "Media seek failed"));
	};
	const timeout = window.setTimeout(() => {
		cleanup();
		reject(new Error(`Media seek timed out after ${SEEK_TIMEOUT_MS} ms`));
	}, SEEK_TIMEOUT_MS);
	element.addEventListener("seeked", onSeeked, { once: true });
	element.addEventListener("error", onError, { once: true });
	element.currentTime = safeTarget;
	return promise;
}

function inspectNativeAudio(element: HTMLMediaElement) {
	const captureStream = (
		element as HTMLMediaElement & { captureStream?: () => MediaStream }
	).captureStream;
	if (!captureStream) return { usable: false, tracksStopped: 0 };
	try {
		const stream = captureStream.call(element);
		const tracks = stream.getTracks();
		const usable = stream
			.getAudioTracks()
			.some((track) => track.readyState === "live");
		for (const track of tracks) track.stop();
		return { usable, tracksStopped: tracks.length };
	} catch {
		return { usable: false, tracksStopped: 0 };
	}
}

export class SyncPlayer {
	#elements: SyncElements;
	#videos: PreparedVideo[] | null = null;
	#durationsUs: number[];
	#usableAudio: boolean[];
	#prepareAbort = new AbortController();
	#audioSession: AudioSyncSession | null = null;
	#automatic: AudioSyncResult | null = null;
	#referenceIndex = 0;
	#focusedIndex = 0;
	#audioMasterIndex = 0;
	#finalOffsetsUs: number[];
	#automaticOffsetsUs: Array<number | null>;
	#currentReferenceTimeUs = 0;
	#pendingSeekTargetUs: number | null = null;
	#seekRequestSequence = 0;
	#resumeAfterPendingSeek = false;
	#playbackSpeed = 1;
	#volume = 1;
	#audioContext: AudioContext | null = null;
	#audioSources: MediaElementAudioSourceNode[] = [];
	#audioGains: GainNode[] = [];
	#audioSetup: Promise<boolean> | null = null;
	#audioProvisionalContext: AudioContext | null = null;
	#volumeRequestSequence = 0;
	#audioBoostUnavailable = false;
	#requestedVolume = 1;
	#muted = false;
	#isPlaying = false;
	#controlsHideTimer = 0;
	#scrubbing = false;
	#restoreFocusAfterAlignment = false;
	#resizingFocus = false;
	#focusSidebarUserSized = false;
	#focusResizeObserver: ResizeObserver | null = null;
	#singleClickTimer = 0;
	#alignmentComplete = false;
	#alignmentOverallProgress = 0;
	#destroyed = false;
	#frameCallbackIds: Array<number | null>;
	#clockTimer = 0;
	#correctionBusy = new Set<number>();
	#lastCorrectionAt: number[];
	#stableDriftSigns: number[];
	#stableDriftCounts: number[];
	#seekCorrectionTimestamps: number[][];
	#onWindowResize = () => {
		requestAnimationFrame(() => {
			if (this.#destroyed || this.#elements.videos.dataset.layout !== "focused")
				return;
			if (this.#focusSidebarUserSized) {
				this.#setFocusSidebarWidth(this.#currentFocusSidebarWidth());
			} else {
				this.#fitFocusSidebarWidth();
			}
		});
	};
	#onFullscreenChange = () => {
		const active = document.fullscreenElement === this.#elements.stage;
		setIconButton(
			this.#elements.fullscreen,
			active ? "Exit fullscreen (F)" : "Fullscreen (F)",
			active ? "fullscreen-exit" : "fullscreen",
		);
		this.#elements.fullscreen.setAttribute("aria-pressed", String(active));
		this.#elements.stage.dataset.fullscreen = String(active);
		this.#onWindowResize();
		this.#showControls();
	};
	#onKeyDown = (event: KeyboardEvent) => {
		const target = event.target;
		const key = event.key.toLowerCase();
		if (this.#elements.helpDialog.open || this.#elements.timingDialog.open)
			return;
		if (
			target === this.#elements.seek &&
			(key === "arrowleft" || key === "arrowright") &&
			!event.altKey &&
			!event.ctrlKey &&
			!event.metaKey
		) {
			event.preventDefault();
			const direction = key === "arrowleft" ? -1 : 1;
			const from = this.#pendingSeekTargetUs ?? this.#currentReferenceTimeUs;
			void this.seekReference(from + direction * 5_000_000);
			return;
		}
		if (
			target instanceof Element &&
			target.closest('input, select, textarea, [contenteditable="true"]')
		) {
			return;
		}
		if (
			(key === " " || key === "enter") &&
			target instanceof Element &&
			target.closest('button, summary, a[href], [role="button"], [role="link"]')
		) {
			return;
		}
		if (event.altKey || event.ctrlKey || event.metaKey) return;
		if (
			event.repeat &&
			(key === " " ||
				key === "k" ||
				key === "m" ||
				key === "f" ||
				key === "v" ||
				key === "?")
		) {
			return;
		}
		this.#showControls();
		if (key === " " || key === "k") {
			event.preventDefault();
			this.#togglePlayback();
			return;
		}
		if (key === "j" || key === "l") {
			event.preventDefault();
			const direction = key === "j" ? -1 : 1;
			const from = this.#pendingSeekTargetUs ?? this.#currentReferenceTimeUs;
			void this.seekReference(from + direction * 10_000_000);
			return;
		}
		if (key === "arrowleft" || key === "arrowright") {
			event.preventDefault();
			const direction = key === "arrowleft" ? -1 : 1;
			const from = this.#pendingSeekTargetUs ?? this.#currentReferenceTimeUs;
			void this.seekReference(from + direction * 5_000_000);
			return;
		}
		if (key === "arrowup" || key === "arrowdown") {
			event.preventDefault();
			void this.#setVolumeGain(
				this.#requestedVolume + (key === "arrowup" ? 0.05 : -0.05),
			);
			return;
		}
		if (key === "m") {
			event.preventDefault();
			this.#muted = !this.#muted;
			this.#applyAudioRouting();
			return;
		}
		if (key === "f") {
			event.preventDefault();
			void this.#requestFullscreen();
			return;
		}
		if (key === "v") {
			event.preventDefault();
			this.#toggleLayout();
			return;
		}
		if (key === "?") {
			event.preventDefault();
			this.#openHelp();
			return;
		}
		if (/^[0-9]$/.test(key)) {
			event.preventDefault();
			const { minimumUs, maximumUs } = this.#referenceRange();
			const fraction = Number(key) / 10;
			void this.seekReference(minimumUs + (maximumUs - minimumUs) * fraction);
		}
	};

	constructor(
		readonly host: HTMLElement,
		readonly files: readonly File[],
		readonly callbacks: SyncPlayerCallbacks,
	) {
		if (files.length < 2 || files.length > 6)
			throw new Error("Select between two and six files");
		const followerOptions = files
			.slice(1)
			.map(
				(_, index) => `<option value="${index + 1}">POV ${index + 2}</option>`,
			)
			.join("");
		const cardsMarkup = files
			.map(
				(_, index) => `
          <article
            class="sync-video-card${index === 0 ? " focused" : ""}"
            data-pov="${index}"
            role="button"
            tabindex="0"
            aria-label="POV ${index + 1}${index === 0 ? ", focused" : ""}"
          >
            <div id="sync-slot-${index}" class="sync-video-slot">
              <span class="sync-pov-label" aria-hidden="true">POV ${index + 1}</span>
              <span id="sync-local-time-${index}" class="visually-hidden">Local 00:00:00.000</span>
              <div id="sync-gap-${index}" class="sync-gap" hidden></div>
            </div>
          </article>`,
			)
			.join("");

		host.innerHTML = `
      <div id="sync-stage" class="sync-stage" data-phase="aligning" data-controls="visible">
        <button id="sync-close" class="sync-icon-button sync-session-exit" type="button"></button>
        <section id="sync-aligning" class="sync-aligning" aria-labelledby="sync-aligning-heading" aria-busy="true">
          <div class="sync-aligning-content">
            <span class="brand-mark sync-aligning-mark" aria-hidden="true">VS</span>
            <h2 id="sync-aligning-heading">Synchronizing ${files.length} POVs</h2>
            <p id="sync-auto-progress" role="status" aria-live="polite">Preparing video 1 of ${files.length}</p>
            <progress id="sync-auto-meter" max="${files.length}" value="0"></progress>
            <p class="sync-aligning-step">Preparing local playback · 0/${files.length}</p>
            <p class="sync-local-note">Processed locally. Recording bytes never leave this browser.</p>
          </div>
        </section>

        <section id="sync-player" class="sync-player" aria-label="Synchronized multi-POV player" hidden>
          <p id="sync-status" class="sync-status visually-hidden" role="status" aria-live="polite"></p>
          <div id="sync-videos" class="sync-videos focused-layout" data-count="${files.length}" data-layout="focused">
            ${cardsMarkup}
            <div
              id="sync-focus-resizer"
              class="sync-focus-resizer"
              role="separator"
              tabindex="0"
              aria-label="Resize Focus view"
              aria-orientation="vertical"
              aria-valuemin="12"
              aria-valuemax="50"
              aria-valuenow="18"
            ></div>
          </div>
          <div class="sync-player-top sync-player-chrome">
            <button id="sync-timing-open" class="sync-top-action" type="button" hidden></button>
            <button id="sync-help" class="sync-icon-button" type="button"></button>
          </div>
          <fieldset id="sync-controls" class="sync-control-bar sync-player-chrome" aria-label="Synchronized playback controls">
            <legend class="visually-hidden">Synchronized playback controls</legend>
            <div class="sync-timeline">
              <input id="sync-seek" type="range" min="0" max="1" step="0.001" value="0" aria-label="Shared timeline" />
            </div>
            <div class="sync-control-row">
              <div class="sync-controls-left">
                <button id="sync-play" class="sync-icon-button sync-play-button" type="button" aria-pressed="false"></button>
                <button id="sync-mute" class="sync-icon-button" type="button" aria-pressed="false"></button>
                <label class="sync-volume">
                  <span class="visually-hidden">Volume</span>
                  <input id="sync-volume" type="range" min="0" max="2" step="0.05" value="1" aria-label="Volume" aria-valuetext="100%" />
                </label>
                <span class="sync-time"><strong id="sync-reference-time">0:00</strong><span aria-hidden="true"> / </span><span id="sync-duration-time">0:00</span></span>
              </div>
              <div class="sync-controls-right">
                <label class="sync-speed">
                  <span class="visually-hidden">Playback speed</span>
                  <select id="sync-speed" aria-label="Playback speed">
                    <option value="0.5">0.5×</option>
                    <option value="0.75">0.75×</option>
                    <option value="1" selected>1×</option>
                    <option value="1.25">1.25×</option>
                    <option value="1.5">1.5×</option>
                    <option value="2">2×</option>
                  </select>
                </label>
                <button id="sync-layout" class="sync-icon-button" type="button" aria-pressed="false"></button>
                <button id="sync-fullscreen" class="sync-icon-button" type="button" aria-pressed="false"></button>
              </div>
            </div>
          </fieldset>
        </section>

        <dialog id="sync-timing-dialog" class="sync-dialog sync-timing-dialog" aria-labelledby="sync-timing-heading">
          <div class="sync-dialog-heading">
            <div>
              <h2 id="sync-timing-heading">Adjust timing</h2>
              <p>Use only when the recordings do not line up.</p>
            </div>
            <button id="sync-timing-close" class="sync-icon-button sync-dialog-close" type="button" aria-label="Close timing controls">×</button>
          </div>
          <p id="sync-timing-notice" class="sync-timing-notice" role="status" hidden></p>
          <div class="sync-offset-heading">
            <span>Current offset</span>
            <strong id="sync-offset-value" class="sync-offset-value">0.000 s</strong>
            <span id="sync-correction-value">No automatic offset yet.</span>
          </div>
          <div class="sync-offset-fields">
            <label>Adjust POV<select id="sync-offset-target">${followerOptions}</select></label>
            <label>Offset seconds<input id="sync-offset" type="number" step="0.001" value="0" inputmode="decimal" /></label>
            <button id="sync-offset-apply" class="secondary-action" type="button">Apply offset</button>
          </div>
          <div class="sync-nudges" aria-label="Offset nudges">
            <button type="button" data-nudge-us="-1000000">−1 s</button>
            <button type="button" data-nudge-us="-100000">−100 ms</button>
            <button type="button" data-nudge-us="-10000">−10 ms</button>
            <button type="button" data-nudge-us="10000">+10 ms</button>
            <button type="button" data-nudge-us="100000">+100 ms</button>
            <button type="button" data-nudge-us="1000000">+1 s</button>
          </div>
          <div class="sync-offset-actions">
            <button id="sync-reset" class="secondary-action" type="button">Reset to zero</button>
            <button id="sync-restore" class="secondary-action" type="button" disabled>Restore estimate</button>
            <button id="sync-accept" class="primary-action" type="button">Use this timing</button>
            <button id="sync-reject" class="danger-action" type="button" disabled>Reject estimate</button>
            <button id="sync-auto" class="secondary-action" type="button">Retry automatic timing</button>
          </div>
        </dialog>

        <dialog id="sync-help-dialog" class="sync-dialog sync-help-dialog" aria-labelledby="sync-help-heading">
          <div class="sync-dialog-heading">
            <div>
              <h2 id="sync-help-heading">Keyboard shortcuts</h2>
              <p>Shortcuts pause while you edit a field or use a menu.</p>
            </div>
            <button id="sync-help-close" class="sync-icon-button sync-dialog-close" type="button" aria-label="Close keyboard shortcuts">×</button>
          </div>
          <dl class="sync-shortcuts">
            <div><dt><kbd>Space</kbd> or <kbd>K</kbd></dt><dd>Play or pause</dd></div>
            <div><dt><kbd>J</kbd> / <kbd>L</kbd></dt><dd>Back or forward 10 seconds</dd></div>
            <div><dt><kbd>←</kbd> / <kbd>→</kbd></dt><dd>Back or forward 5 seconds</dd></div>
            <div><dt><kbd>↑</kbd> / <kbd>↓</kbd></dt><dd>Volume up or down</dd></div>
            <div><dt><kbd>M</kbd></dt><dd>Mute or unmute</dd></div>
            <div><dt><kbd>F</kbd></dt><dd>Enter or exit fullscreen</dd></div>
            <div><dt><kbd>V</kbd></dt><dd>Switch Focus and Grid views</dd></div>
            <div><dt><kbd>0</kbd>–<kbd>9</kbd></dt><dd>Seek to a percentage</dd></div>
            <div><dt><kbd>?</kbd></dt><dd>Open this shortcut list</dd></div>
          </dl>
        </dialog>
      </div>

      <div id="sync-staging" hidden></div>
    `;

		this.#elements = {
			stage: requiredElement(host, "#sync-stage"),
			aligning: requiredElement(host, "#sync-aligning"),
			player: requiredElement(host, "#sync-player"),
			status: requiredElement(host, "#sync-status"),
			videos: requiredElement(host, "#sync-videos"),
			focusResizer: requiredElement(host, "#sync-focus-resizer"),
			cards: files.map((_, index) =>
				requiredElement(host, `[data-pov="${index}"]`),
			),
			slots: files.map((_, index) =>
				requiredElement(host, `#sync-slot-${index}`),
			),
			gaps: files.map((_, index) =>
				requiredElement(host, `#sync-gap-${index}`),
			),
			localTimes: files.map((_, index) =>
				requiredElement(host, `#sync-local-time-${index}`),
			),
			controls: requiredElement(host, "#sync-controls"),
			timeline: requiredElement(host, ".sync-timeline"),
			play: requiredElement(host, "#sync-play"),
			seek: requiredElement(host, "#sync-seek"),
			referenceTime: requiredElement(host, "#sync-reference-time"),
			durationTime: requiredElement(host, "#sync-duration-time"),
			speed: requiredElement(host, "#sync-speed"),
			volume: requiredElement(host, "#sync-volume"),
			mute: requiredElement(host, "#sync-mute"),
			layout: requiredElement(host, "#sync-layout"),
			fullscreen: requiredElement(host, "#sync-fullscreen"),
			help: requiredElement(host, "#sync-help"),
			helpDialog: requiredElement(host, "#sync-help-dialog"),
			helpClose: requiredElement(host, "#sync-help-close"),
			timingOpen: requiredElement(host, "#sync-timing-open"),
			timingDialog: requiredElement(host, "#sync-timing-dialog"),
			timingClose: requiredElement(host, "#sync-timing-close"),
			timingNotice: requiredElement(host, "#sync-timing-notice"),
			offsetTarget: requiredElement(host, "#sync-offset-target"),
			offset: requiredElement(host, "#sync-offset"),
			offsetApply: requiredElement(host, "#sync-offset-apply"),
			offsetValue: requiredElement(host, "#sync-offset-value"),
			correctionValue: requiredElement(host, "#sync-correction-value"),
			nudgeButtons: [
				...host.querySelectorAll<HTMLButtonElement>("[data-nudge-us]"),
			],
			reset: requiredElement(host, "#sync-reset"),
			restore: requiredElement(host, "#sync-restore"),
			accept: requiredElement(host, "#sync-accept"),
			reject: requiredElement(host, "#sync-reject"),
			auto: requiredElement(host, "#sync-auto"),
			autoProgress: requiredElement(host, "#sync-auto-progress"),
			autoMeter: requiredElement(host, "#sync-auto-meter"),
			close: requiredElement(host, "#sync-close"),
			staging: requiredElement(host, "#sync-staging"),
		};
		setIconButton(
			this.#elements.close,
			"Cancel synchronization and clean up",
			"back",
		);
		setIconButton(this.#elements.play, "Play (K)", "play");
		setIconButton(this.#elements.mute, "Mute (M)", "volume");
		setIconButton(this.#elements.layout, "Switch to Grid view (V)", "grid");
		setIconButton(this.#elements.fullscreen, "Fullscreen (F)", "fullscreen");
		setIconButton(this.#elements.help, "Keyboard shortcuts (?)", "help");
		setIconButton(
			this.#elements.timingOpen,
			"Review synchronization timing",
			"timing",
		);
		this.#durationsUs = files.map(() => 0);
		this.#usableAudio = files.map(() => false);
		this.#finalOffsetsUs = files.map(() => 0);
		this.#automaticOffsetsUs = files.map(() => null);
		this.#frameCallbackIds = files.map(() => null);
		this.#lastCorrectionAt = files.map(() => Number.NEGATIVE_INFINITY);
		this.#stableDriftSigns = files.map(() => 0);
		this.#stableDriftCounts = files.map(() => 0);
		this.#seekCorrectionTimestamps = files.map(() => []);
	}

	async open() {
		this.#wireControls();
		const preparation = await prepareVideos(
			this.files,
			this.#elements.staging,
			this.#prepareAbort.signal,
			({ inputIndex, completed, total, status }) => {
				const label =
					status === "preparing"
						? `Preparing video ${inputIndex + 1} of ${total}`
						: `${status === "ready" ? "Prepared" : "Could not prepare"} video ${inputIndex + 1} of ${total}`;
				this.#setAlignmentProgress(label, completed, total, 0, 0.15);
			},
		);
		if (this.#destroyed) {
			cleanupVideos(preparation.videos);
			return;
		}
		if (preparation.videos.length !== this.files.length) {
			cleanupVideos(preparation.videos);
			const reason = preparation.failures
				.map(({ name, error }) => `${name}: ${error}`)
				.join("; ");
			throw new Error(
				reason || "Every selected recording must support native playback",
			);
		}
		this.#videos = preparation.videos;
		this.#durationsUs = this.#videos.map(({ element }) =>
			secondsToMicroseconds(element.duration),
		);
		const audioAvailability = this.#videos.map(({ element }) =>
			inspectNativeAudio(element),
		);
		this.#usableAudio = audioAvailability.map(({ usable }) => usable);
		const initialAudioIndex = this.#usableAudio.findIndex(Boolean);
		this.#audioMasterIndex = initialAudioIndex >= 0 ? initialAudioIndex : 0;
		for (const [index, prepared] of this.#videos.entries()) {
			prepared.element.controls = false;
			prepared.element.playsInline = true;
			prepared.element.preload = "auto";
			prepared.element.muted = true;
			prepared.element.volume = this.#volume;
			prepared.element.setAttribute(
				"aria-label",
				`POV ${index + 1} synchronized video`,
			);
			this.#elements.slots[index]?.prepend(prepared.element);
			prepared.element.addEventListener("dblclick", (event) => {
				event.preventDefault();
				window.clearTimeout(this.#singleClickTimer);
				void this.#requestFullscreen();
			});
			prepared.element.addEventListener("ended", () =>
				this.#onMediaEnded(index),
			);
			prepared.element.addEventListener("error", () => {
				this.pause("Media playback failed.");
			});
		}
		this.#applyAudioRouting();
		this.#elements.staging.remove();
		this.#setReferenceRange();
		this.#renderFocusState();
		this.#renderTimeline();
		this.#renderOffset();

		this.#startFrameObservation();
		this.#focusResizeObserver = new ResizeObserver(this.#onWindowResize);
		this.#focusResizeObserver.observe(this.#elements.videos);
		window.addEventListener("keydown", this.#onKeyDown);
		window.addEventListener("resize", this.#onWindowResize);
		document.addEventListener("fullscreenchange", this.#onFullscreenChange);

		await this.#runAutomaticAlignment();
	}

	#wireControls() {
		this.#elements.play.addEventListener("click", () => this.#togglePlayback());
		this.#elements.seek.addEventListener("pointerdown", (event) => {
			this.#scrubbing = true;
			this.#elements.seek.setPointerCapture(event.pointerId);
			if (this.#isPlaying) {
				for (const { element } of this.#videos ?? []) element.pause();
			}
			this.#showControls();
		});
		this.#elements.seek.addEventListener("input", () => {
			this.#scrubbing = true;
			this.#previewScrub(
				secondsToMicroseconds(Number(this.#elements.seek.value)),
			);
		});
		const finishScrub = () => {
			if (!this.#scrubbing) return;
			this.#scrubbing = false;
			void this.seekReference(
				secondsToMicroseconds(Number(this.#elements.seek.value)),
			);
			this.#scheduleControlsHide();
		};
		this.#elements.seek.addEventListener("change", finishScrub);
		this.#elements.seek.addEventListener("pointerup", finishScrub);
		this.#elements.seek.addEventListener("pointercancel", finishScrub);
		this.#elements.seek.addEventListener("lostpointercapture", finishScrub);
		this.#elements.speed.addEventListener("change", () => {
			this.#setPlaybackSpeed(Number(this.#elements.speed.value));
			this.#showControls();
		});
		this.#elements.volume.addEventListener("input", () => {
			void this.#setVolumeGain(Number(this.#elements.volume.value));
			this.#showControls();
		});
		this.#elements.mute.addEventListener("click", () => {
			this.#muted = !this.#muted;
			this.#applyAudioRouting();
			this.#showControls();
		});
		this.#elements.layout.addEventListener("click", () => this.#toggleLayout());
		this.#elements.focusResizer.addEventListener("pointerdown", (event) => {
			if (this.#elements.videos.dataset.layout !== "focused") return;
			event.preventDefault();
			this.#resizingFocus = true;
			this.#elements.videos.dataset.resizing = "true";
			this.#elements.focusResizer.setPointerCapture(event.pointerId);
			this.#setFocusSidebarWidth(
				this.#elements.videos.getBoundingClientRect().right - event.clientX,
			);
			this.#showControls();
		});
		this.#elements.focusResizer.addEventListener("pointermove", (event) => {
			if (!this.#elements.focusResizer.hasPointerCapture(event.pointerId))
				return;
			this.#setFocusSidebarWidth(
				this.#elements.videos.getBoundingClientRect().right - event.clientX,
			);
		});
		const finishFocusResize = (event: PointerEvent) => {
			if (this.#elements.focusResizer.hasPointerCapture(event.pointerId)) {
				this.#elements.focusResizer.releasePointerCapture(event.pointerId);
			}
			this.#resizingFocus = false;
			delete this.#elements.videos.dataset.resizing;
			this.#scheduleControlsHide();
		};
		this.#elements.focusResizer.addEventListener(
			"pointerup",
			finishFocusResize,
		);
		this.#elements.focusResizer.addEventListener(
			"pointercancel",
			finishFocusResize,
		);
		this.#elements.focusResizer.addEventListener("dblclick", () =>
			this.#resetFocusSidebarWidth(),
		);
		this.#elements.focusResizer.addEventListener("keydown", (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				this.#resetFocusSidebarWidth();
				return;
			}
			if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
				return;
			event.preventDefault();
			event.stopPropagation();
			const { minimum, maximum } = this.#focusSidebarBounds();
			const current = this.#currentFocusSidebarWidth();
			const width =
				event.key === "Home"
					? minimum
					: event.key === "End"
						? maximum
						: current + (event.key === "ArrowLeft" ? 16 : -16);
			this.#setFocusSidebarWidth(width);
		});
		this.#elements.fullscreen.addEventListener(
			"click",
			() => void this.#requestFullscreen(),
		);
		this.#elements.help.addEventListener("click", () => this.#openHelp());
		this.#elements.helpClose.addEventListener("click", () =>
			this.#elements.helpDialog.close(),
		);
		this.#elements.timingOpen.addEventListener("click", () => {
			this.#elements.timingDialog.showModal();
			this.#showControls();
		});
		this.#elements.timingClose.addEventListener("click", () =>
			this.#elements.timingDialog.close(),
		);
		for (const [index, card] of this.#elements.cards.entries()) {
			card.addEventListener("click", () => this.#activateVideo(index));
			card.addEventListener("keydown", (event) => {
				if (event.key !== "Enter" && event.key !== " ") return;
				event.preventDefault();
				event.stopPropagation();
				if (event.repeat) return;
				this.#activateVideo(index);
			});
		}
		for (const eventName of [
			"pointermove",
			"pointerdown",
			"touchstart",
			"focusin",
		] as const) {
			this.#elements.stage.addEventListener(
				eventName,
				() => this.#showControls(),
				{
					passive: true,
				},
			);
		}
		this.#elements.controls.addEventListener("pointerenter", () => {
			window.clearTimeout(this.#controlsHideTimer);
		});
		this.#elements.controls.addEventListener("pointerleave", () =>
			this.#scheduleControlsHide(),
		);
		this.#elements.offsetTarget.addEventListener("change", () => {
			this.#renderOffset();
		});
		this.#elements.offsetApply.addEventListener("click", () => {
			const seconds = Number(this.#elements.offset.value);
			if (!Number.isFinite(seconds)) {
				this.#setStatus("Enter a finite offset in seconds.", "error");
				return;
			}
			void this.#applyFinalOffset(
				this.#selectedOffsetIndex(),
				secondsToMicroseconds(seconds),
				"Manual offset applied",
			);
		});
		for (const button of this.#elements.nudgeButtons) {
			button.addEventListener("click", () => {
				const nudgeUs = Number(button.dataset.nudgeUs);
				const index = this.#selectedOffsetIndex();
				if (!Number.isSafeInteger(nudgeUs)) return;
				void this.#applyFinalOffset(
					index,
					(this.#finalOffsetsUs[index] ?? 0) + nudgeUs,
					`Offset nudged ${formatOffset(nudgeUs)}`,
				);
			});
		}
		this.#elements.reset.addEventListener("click", () => {
			void this.#applyFinalOffset(
				this.#selectedOffsetIndex(),
				0,
				"Offset reset to zero",
			);
		});
		this.#elements.restore.addEventListener("click", () => {
			const index = this.#selectedOffsetIndex();
			const offsetUs = this.#automaticOffsetsUs[index];
			if (offsetUs === null || offsetUs === undefined) return;
			void this.#applyFinalOffset(index, offsetUs, "Automatic offset restored");
		});
		this.#elements.accept.addEventListener("click", () => {
			const index = this.#selectedOffsetIndex();
			this.#elements.timingDialog.close();
			this.#setStatus(
				`Accepted POV ${index + 1} offset ${formatOffset(this.#finalOffsetsUs[index] ?? 0)}.`,
				"success",
			);
			this.#renderOffset();
		});
		this.#elements.reject.addEventListener("click", () => {
			const index = this.#selectedOffsetIndex();
			void this.#applyFinalOffset(index, 0, "Automatic estimate rejected");
		});
		this.#elements.auto.addEventListener("click", () => {
			if (this.#elements.timingDialog.open) this.#elements.timingDialog.close();
			void this.#runAutomaticAlignment();
		});
		this.#elements.close.addEventListener("click", () => {
			this.host.dispatchEvent(new CustomEvent("sync-close-requested"));
		});
	}

	#setAlignmentProgress(
		label: string,
		completed: number,
		total: number,
		overallStart = 0,
		overallEnd = 1,
	) {
		const safeTotal = Math.max(1, total);
		const safeCompleted = Math.max(0, Math.min(completed, safeTotal));
		const stageFraction = safeCompleted / safeTotal;
		const overallCandidate =
			overallStart + (overallEnd - overallStart) * stageFraction;
		this.#alignmentOverallProgress = Math.max(
			this.#alignmentOverallProgress,
			Math.min(1, overallCandidate),
		);
		this.#elements.autoProgress.textContent = label;
		this.#elements.autoMeter.max = 1_000;
		this.#elements.autoMeter.value = Math.round(
			this.#alignmentOverallProgress * 1_000,
		);
		const step = this.host.querySelector<HTMLElement>(".sync-aligning-step");
		if (step) {
			step.textContent = `${label} · ${safeCompleted}/${safeTotal} · ${Math.round(this.#alignmentOverallProgress * 100)}% overall`;
		}
	}

	#showAlignment() {
		const active = document.activeElement;
		this.#restoreFocusAfterAlignment ||=
			active instanceof Element && this.#elements.player.contains(active);
		if (this.#isPlaying) this.pause("Playback paused for synchronization.");
		this.#alignmentComplete = false;
		this.#elements.stage.dataset.phase = "aligning";
		this.#elements.aligning.hidden = false;
		this.#elements.aligning.setAttribute("aria-busy", "true");
		this.#elements.player.hidden = true;
		setIconButton(
			this.#elements.close,
			"Cancel synchronization and clean up",
			"back",
		);
		this.#elements.close.focus({ preventScroll: true });
		window.clearTimeout(this.#controlsHideTimer);
	}

	#showPlayer() {
		if (this.#destroyed) return;
		this.#alignmentComplete = true;
		this.#elements.stage.dataset.phase = "player";
		this.#elements.aligning.hidden = true;
		this.#elements.aligning.setAttribute("aria-busy", "false");
		this.#elements.player.hidden = false;
		setIconButton(this.#elements.close, "Exit review and clean up", "back");
		if (this.#restoreFocusAfterAlignment) {
			const target = this.#elements.timingOpen.hidden
				? this.#elements.play
				: this.#elements.timingOpen;
			target.focus({ preventScroll: true });
			this.#restoreFocusAfterAlignment = false;
		} else {
			const active = document.activeElement;
			if (
				!(active instanceof HTMLElement) ||
				!this.#elements.player.contains(active) ||
				active.matches(":disabled")
			) {
				this.#elements.play.focus({ preventScroll: true });
			}
		}
		this.#showControls();
		requestAnimationFrame(() => {
			if (!this.#destroyed) this.#fitFocusSidebarWidth();
		});
	}

	#showControls() {
		if (!this.#alignmentComplete) return;
		this.#elements.stage.dataset.controls = "visible";
		window.clearTimeout(this.#controlsHideTimer);
		this.#scheduleControlsHide();
	}

	#playerChromeHovered() {
		return (
			this.#elements.controls.matches(":hover") ||
			this.#elements.close.matches(":hover") ||
			this.#elements.timingOpen.matches(":hover") ||
			this.#elements.help.matches(":hover")
		);
	}

	#scheduleControlsHide() {
		window.clearTimeout(this.#controlsHideTimer);
		if (
			!this.#isPlaying ||
			this.#scrubbing ||
			this.#resizingFocus ||
			this.#playerChromeHovered() ||
			this.#elements.helpDialog.open ||
			this.#elements.timingDialog.open
		) {
			return;
		}
		this.#controlsHideTimer = window.setTimeout(() => {
			const active = document.activeElement;
			const keyboardFocusedChrome =
				active instanceof Element &&
				active.matches(":focus-visible") &&
				active.closest(".sync-player-chrome, .sync-session-exit") !== null;
			if (
				!this.#isPlaying ||
				this.#scrubbing ||
				this.#playerChromeHovered() ||
				keyboardFocusedChrome
			) {
				return;
			}
			this.#elements.stage.dataset.controls = "hidden";
		}, 2_400);
	}

	#togglePlayback() {
		if (!this.#alignmentComplete) return;
		if (this.#isPlaying) this.pause("Playback paused.");
		else void this.play();
	}

	#activateVideo(index: number) {
		if (!this.#alignmentComplete) return;
		this.#showControls();
		window.clearTimeout(this.#singleClickTimer);
		if (index !== this.#focusedIndex) {
			void this.focusPov(index);
			return;
		}
		this.#singleClickTimer = window.setTimeout(
			() => this.#togglePlayback(),
			220,
		);
	}

	#openHelp() {
		if (!this.#elements.helpDialog.open) this.#elements.helpDialog.showModal();
		this.#showControls();
	}

	#toggleLayout() {
		const current = this.#elements.videos.dataset.layout;
		this.#setLayout(current === "focused" ? "tiled" : "focused");
		this.#showControls();
	}

	#selectedOffsetIndex() {
		const index = Number(this.#elements.offsetTarget.value);
		if (Number.isInteger(index) && index >= 0 && index < this.files.length)
			return index;
		return this.files.findIndex(
			(_, candidate) => candidate !== this.#referenceIndex,
		);
	}

	#offsetFor(index: number) {
		return this.#finalOffsetsUs[index] ?? 0;
	}

	#durationUs(index: number) {
		return this.#durationsUs[index] ?? 0;
	}

	#isCovered(index: number, referenceTimeUs = this.#currentReferenceTimeUs) {
		const localUs = referenceToLocalUs(referenceTimeUs, this.#offsetFor(index));
		return isLocalTimeCovered(localUs, this.#durationUs(index));
	}

	#preferredAudioMaster(referenceTimeUs: number) {
		if (
			this.#usableAudio[this.#focusedIndex] &&
			this.#isCovered(this.#focusedIndex, referenceTimeUs)
		) {
			return this.#focusedIndex;
		}
		if (
			this.#usableAudio[this.#audioMasterIndex] &&
			this.#isCovered(this.#audioMasterIndex, referenceTimeUs)
		) {
			return this.#audioMasterIndex;
		}
		const fallback = this.#usableAudio.findIndex(
			(usable, index) => usable && this.#isCovered(index, referenceTimeUs),
		);
		return fallback >= 0 ? fallback : null;
	}

	#referenceAtMaster() {
		const master = this.#videos?.[this.#audioMasterIndex]?.element;
		if (!master) return this.#currentReferenceTimeUs;
		return localToReferenceUs(
			secondsToMicroseconds(master.currentTime),
			this.#offsetFor(this.#audioMasterIndex),
		);
	}

	#referenceRange() {
		let minimumUs = 0;
		let maximumUs = 1_000;
		for (let index = 0; index < this.files.length; index += 1) {
			const offsetUs = this.#offsetFor(index);
			minimumUs = Math.min(minimumUs, offsetUs);
			maximumUs = Math.max(maximumUs, offsetUs + this.#durationUs(index));
		}
		return { minimumUs, maximumUs };
	}

	#setReferenceRange() {
		const { minimumUs, maximumUs } = this.#referenceRange();
		this.#elements.seek.min = String(microsecondsToSeconds(minimumUs));
		this.#elements.seek.max = String(microsecondsToSeconds(maximumUs));
		this.#elements.durationTime.textContent = formatPlayerTime(maximumUs);
	}

	#setStatus(message: string, tone: SyncStatusTone = "neutral") {
		this.#elements.status.textContent = message;
		this.#elements.status.dataset.tone = tone;
		this.callbacks.onStatus(message, tone);
	}

	#renderTimeline() {
		this.#elements.referenceTime.textContent = formatPlayerTime(
			this.#currentReferenceTimeUs,
		);
		const minimum = Number(this.#elements.seek.min);
		const maximum = Number(this.#elements.seek.max);
		const currentSeconds = microsecondsToSeconds(this.#currentReferenceTimeUs);
		this.#elements.seek.value = String(
			Math.max(minimum, Math.min(maximum, currentSeconds)),
		);
		const progress =
			maximum > minimum
				? ((currentSeconds - minimum) / (maximum - minimum)) * 100
				: 0;
		this.#elements.timeline.style.setProperty(
			"--seek-progress",
			`${Math.max(0, Math.min(100, progress))}%`,
		);
		for (let index = 0; index < this.files.length; index += 1) {
			const localUs = referenceToLocalUs(
				this.#currentReferenceTimeUs,
				this.#offsetFor(index),
			);
			const output = this.#elements.localTimes[index];
			if (output) output.textContent = `Local ${formatTime(localUs)}`;
		}
		this.#updateGaps(this.#currentReferenceTimeUs);
	}

	#previewScrub(referenceTimeUs: number) {
		const { minimumUs, maximumUs } = this.#referenceRange();
		const targetUs = Math.max(minimumUs, Math.min(maximumUs, referenceTimeUs));
		this.#currentReferenceTimeUs = targetUs;
		for (let index = 0; index < (this.#videos?.length ?? 0); index += 1) {
			const video = this.#videos?.[index]?.element;
			if (!video) continue;
			const localUs = referenceToLocalUs(targetUs, this.#offsetFor(index));
			if (!isLocalTimeCovered(localUs, this.#durationUs(index))) {
				video.pause();
				continue;
			}
			video.currentTime = microsecondsToSeconds(localUs);
		}
		this.#renderTimeline();
	}

	#renderOffset() {
		const index = this.#selectedOffsetIndex();
		const finalOffsetUs = this.#finalOffsetsUs[index] ?? 0;

		const automaticOffsetUs = this.#automaticOffsetsUs[index];
		this.#elements.offset.value = (finalOffsetUs / 1_000_000).toFixed(3);
		this.#elements.offsetValue.textContent = formatOffset(finalOffsetUs);
		this.#elements.restore.disabled =
			automaticOffsetUs === null || automaticOffsetUs === undefined;
		this.#elements.reject.disabled =
			automaticOffsetUs === null || automaticOffsetUs === undefined;
		this.#elements.correctionValue.textContent =
			automaticOffsetUs === null || automaticOffsetUs === undefined
				? `POV ${index + 1} · no automatic estimate yet`
				: `Automatic estimate ${formatOffset(automaticOffsetUs)} · adjusted ${formatOffset(finalOffsetUs - automaticOffsetUs)}`;
	}

	#renderFocusState() {
		for (let index = 0; index < this.files.length; index += 1) {
			const focused = index === this.#focusedIndex;
			const audioMaster =
				index === this.#audioMasterIndex && this.#usableAudio[index];
			const card = this.#elements.cards[index];
			card?.classList.toggle("focused", focused);
			card?.toggleAttribute("data-audio-master", audioMaster);
			card?.setAttribute("aria-pressed", String(focused));
			card?.setAttribute(
				"aria-label",
				`POV ${index + 1}${focused ? ", focused" : ""}${audioMaster ? ", audio" : ""}`,
			);
		}
	}

	#updateGaps(referenceTimeUs: number) {
		for (let index = 0; index < this.files.length; index += 1) {
			const localUs = referenceToLocalUs(
				referenceTimeUs,
				this.#offsetFor(index),
			);
			const state: GapState = isLocalTimeCovered(
				localUs,
				this.#durationUs(index),
			)
				? "covered"
				: localUs < 0
					? "pre-start"
					: "post-end";
			const overlay = this.#elements.gaps[index];
			const card = this.#elements.cards[index];
			if (overlay) {
				overlay.hidden = state === "covered";
				overlay.textContent =
					state === "pre-start"
						? `POV ${index + 1} has not started yet.`
						: state === "post-end"
							? `POV ${index + 1} has ended.`
							: "";
			}
			if (card) card.dataset.gap = state;
		}
	}

	#disconnectAudioNodes(nodes: AudioNode[]) {
		for (const node of nodes) {
			try {
				node.disconnect();
			} catch {}
		}
	}

	async #closeAudioContext(context: AudioContext) {
		if (context.state === "closed") return;
		try {
			await context.close();
		} catch {}
	}

	async #initializeAudioBoost() {
		const videos = this.#videos;
		const AudioContextConstructor =
			window.AudioContext ??
			(window as Window & { webkitAudioContext?: typeof AudioContext })
				.webkitAudioContext;
		if (!AudioContextConstructor || !videos) {
			this.#audioBoostUnavailable = !AudioContextConstructor;
			return false;
		}

		let context: AudioContext | null = null;
		let retryable = false;
		const sources: MediaElementAudioSourceNode[] = [];
		const gains: GainNode[] = [];
		try {
			context = new AudioContextConstructor();
			this.#audioProvisionalContext = context;
			if (context.state !== "running") {
				try {
					await context.resume();
				} catch (error) {
					retryable = true;
					throw error;
				}
			}
			if (this.#destroyed) {
				await this.#closeAudioContext(context);
				if (this.#audioProvisionalContext === context)
					this.#audioProvisionalContext = null;
				return false;
			}
			for (const { element } of videos) {
				const source = context.createMediaElementSource(element);
				sources.push(source);
				const gain = context.createGain();
				gains.push(gain);
				source.connect(gain);
				gain.connect(context.destination);
			}
			if (this.#audioProvisionalContext === context)
				this.#audioProvisionalContext = null;
			this.#audioContext = context;
			this.#audioSources = sources;
			this.#audioGains = gains;
			this.#applyAudioRouting();
			return true;
		} catch (error) {
			this.#disconnectAudioNodes(sources);
			this.#disconnectAudioNodes(gains);
			if (context) await this.#closeAudioContext(context);
			if (this.#audioProvisionalContext === context)
				this.#audioProvisionalContext = null;
			if (!this.#destroyed) {
				this.#audioBoostUnavailable = !retryable;
			}
			return false;
		}
	}

	async #enableAudioBoost() {
		if (this.#audioContext) return true;
		if (this.#audioBoostUnavailable || !this.#videos || this.#destroyed)
			return false;
		if (this.#audioSetup) return this.#audioSetup;
		const setup = this.#initializeAudioBoost();
		this.#audioSetup = setup;
		try {
			return await setup;
		} finally {
			if (this.#audioSetup === setup) this.#audioSetup = null;
		}
	}

	async #setVolumeGain(value: number) {
		if (!Number.isFinite(value)) return;
		const request = ++this.#volumeRequestSequence;
		let gain = Math.max(0, Math.min(2, value));
		this.#requestedVolume = gain;
		const boostAvailable = gain <= 1 || (await this.#enableAudioBoost());
		if (request !== this.#volumeRequestSequence || this.#destroyed) return;
		if (!boostAvailable) {
			gain = 1;
			this.#requestedVolume = gain;
			this.#setStatus(
				"Volume boost is unavailable in this browser; using 100%.",
				"warning",
			);
		}
		this.#volume = gain;
		this.#applyAudioRouting();
	}

	async #resumeAudioOutput() {
		if (
			!this.#audioContext ||
			["running", "closed"].includes(this.#audioContext.state)
		)
			return;
		await this.#audioContext.resume();
	}

	async #closeAudioOutput() {
		if (!this.#audioContext) return;
		const context = this.#audioContext;
		const nodes: AudioNode[] = [...this.#audioSources, ...this.#audioGains];
		this.#audioContext = null;
		this.#audioSources = [];
		this.#audioGains = [];
		this.#disconnectAudioNodes(nodes);
		await this.#closeAudioContext(context);
	}

	#applyAudioRouting() {
		const videos = this.#videos ?? [];
		const amplified =
			this.#audioContext !== null && this.#audioGains.length === videos.length;
		for (const [index, video] of videos.entries()) {
			const audible =
				!this.#muted &&
				Boolean(this.#usableAudio[this.#audioMasterIndex]) &&
				index === this.#audioMasterIndex;
			if (amplified) {
				video.element.volume = 1;
				video.element.muted = false;
				const gain = this.#audioGains[index];
				if (gain) gain.gain.value = audible ? this.#volume : 0;
			} else {
				video.element.volume = Math.min(1, this.#volume);
				video.element.muted = !audible;
			}
		}
		const percentage = Math.round(this.#volume * 100);
		this.#elements.volume.value = String(this.#volume);
		this.#elements.volume.setAttribute("aria-valuetext", `${percentage}%`);
		this.#elements.volume.title = `Volume ${percentage}%`;
		setIconButton(
			this.#elements.mute,
			this.#muted ? "Unmute (M)" : "Mute (M)",
			this.#muted || this.#volume === 0 ? "muted" : "volume",
		);
		this.#elements.mute.setAttribute("aria-pressed", String(this.#muted));
		this.#renderFocusState();
	}

	#setAudioMaster(index: number) {
		if (index === this.#audioMasterIndex) {
			this.#applyAudioRouting();
			return;
		}
		this.#audioMasterIndex = index;
		this.#applyAudioRouting();
	}

	#renderTransportState() {
		setIconButton(
			this.#elements.play,
			this.#isPlaying ? "Pause (K)" : "Play (K)",
			this.#isPlaying ? "pause" : "play",
		);
		this.#elements.play.setAttribute("aria-pressed", String(this.#isPlaying));
		if (this.#isPlaying) this.#scheduleControlsHide();
		else this.#showControls();
	}

	async #seekCovered(referenceTimeUs: number) {
		const operations: Promise<void>[] = [];
		for (const [index, video] of (this.#videos ?? []).entries()) {
			const localUs = referenceToLocalUs(
				referenceTimeUs,
				this.#offsetFor(index),
			);
			if (!isLocalTimeCovered(localUs, this.#durationUs(index))) {
				video.element.pause();
				video.element.playbackRate = this.#playbackSpeed;
				continue;
			}
			operations.push(
				waitForSeek(video.element, microsecondsToSeconds(localUs)),
			);
		}
		await Promise.all(operations);
	}

	async seekReference(referenceTimeUs: number) {
		const { minimumUs, maximumUs } = this.#referenceRange();
		const target = Math.max(
			minimumUs,
			Math.min(maximumUs, Math.round(referenceTimeUs)),
		);
		const request = ++this.#seekRequestSequence;
		this.#pendingSeekTargetUs = target;
		this.#resumeAfterPendingSeek ||= this.#isPlaying;
		this.#isPlaying = false;
		for (const { element } of this.#videos ?? []) element.pause();
		this.#renderTransportState();
		try {
			await this.#seekCovered(target);
			if (request !== this.#seekRequestSequence || this.#destroyed)
				return false;
			const resume = this.#resumeAfterPendingSeek;
			this.#pendingSeekTargetUs = null;
			this.#resumeAfterPendingSeek = false;
			this.#currentReferenceTimeUs = target;
			this.#renderTimeline();
			this.#resetDriftBaseline();

			if (resume && !(await this.#playCovered())) return false;
			const blankPovs = this.files
				.map((_, index) => index)
				.filter((index) => !this.#isCovered(index, target));
			this.#setStatus(
				blankPovs.length === 0
					? `${resume ? "Playback resumed" : "Timeline moved"} at ${formatTime(target)}.`
					: `${resume ? "Playback resumed" : "Timeline moved"} at ${formatTime(target)}; ${blankPovs.map((index) => `POV ${index + 1}`).join(", ")} is outside its recorded range.`,
				blankPovs.length === 0 ? "success" : "warning",
			);
			return true;
		} catch (error) {
			if (request !== this.#seekRequestSequence || this.#destroyed)
				return false;
			this.#pendingSeekTargetUs = null;
			this.#resumeAfterPendingSeek = false;
			this.#isPlaying = false;
			for (const { element } of this.#videos ?? []) element.pause();
			this.#renderTransportState();
			const message = error instanceof Error ? error.message : String(error);

			this.#setStatus(`Seek failed: ${message}`, "error");
			return false;
		}
	}

	async #playCovered() {
		const videos = this.#videos;
		if (!videos) return false;
		const covered = videos.map((_, index) => this.#isCovered(index));
		if (!covered.some(Boolean)) {
			this.#isPlaying = false;
			this.#renderTransportState();
			this.#setStatus(
				"No selected POV covers this point on the shared timeline.",
				"warning",
			);
			return false;
		}
		const masterIndex = this.#preferredAudioMaster(
			this.#currentReferenceTimeUs,
		);
		if (masterIndex !== null) this.#setAudioMaster(masterIndex);
		else this.#applyAudioRouting();
		for (const { element } of videos)
			element.playbackRate = this.#playbackSpeed;
		await this.#resumeAudioOutput();
		await Promise.all(
			videos.map(async ({ element }, index) => {
				if (!covered[index]) {
					element.pause();
					return;
				}
				const localUs = referenceToLocalUs(
					this.#currentReferenceTimeUs,
					this.#offsetFor(index),
				);
				const expectedSeconds = microsecondsToSeconds(localUs);
				if (Math.abs(element.currentTime - expectedSeconds) > 0.08) {
					await waitForSeek(element, expectedSeconds);
				}
				await element.play();
			}),
		);
		this.#isPlaying = true;
		this.#renderTransportState();
		return true;
	}

	async play(announceStatus = true) {
		try {
			if (!(await this.#playCovered())) return;
			const coveredCount = this.files.reduce(
				(count, _, index) => count + Number(this.#isCovered(index)),
				0,
			);

			if (announceStatus) {
				this.#setStatus(
					coveredCount === this.files.length
						? `Playing all ${coveredCount} POVs at ${this.#playbackSpeed}×.`
						: `Playing ${coveredCount} covered POV${coveredCount === 1 ? "" : "s"} at ${this.#playbackSpeed}×; unavailable POVs remain blank.`,
					coveredCount === this.files.length ? "success" : "warning",
				);
			}
		} catch (error) {
			this.#isPlaying = false;
			for (const { element } of this.#videos ?? []) element.pause();
			this.#renderTransportState();
			const message = error instanceof Error ? error.message : String(error);

			this.#setStatus(`Playback failed: ${message}`, "error");
		}
	}

	pause(message = "Playback paused.") {
		this.#isPlaying = false;
		for (const { element } of this.#videos ?? []) {
			element.pause();
			element.playbackRate = this.#playbackSpeed;
		}
		this.#renderTransportState();

		this.#setStatus(message, "neutral");
	}

	#setPlaybackSpeed(speed: number) {
		if (!Number.isFinite(speed) || speed < 0.25 || speed > 4) return;
		this.#playbackSpeed = speed;
		for (const { element } of this.#videos ?? []) element.playbackRate = speed;

		this.#setStatus(`Synchronized playback speed set to ${speed}×.`, "success");
	}

	#focusSidebarBounds() {
		const width = Math.max(
			1,
			this.#elements.videos.getBoundingClientRect().width,
		);
		const minimum = Math.min(144, width * 0.35);
		return {
			containerWidth: width,
			minimum,
			maximum: Math.max(minimum, width * 0.5),
		};
	}

	#fitFocusSidebarWidth() {
		if (this.#elements.videos.dataset.layout !== "focused") return;
		const { height } = this.#elements.videos.getBoundingClientRect();
		if (height <= 0) return;
		const previewRows = Math.max(1, this.files.length - 1);
		const widestPreviewAspect =
			this.#videos
				?.filter((_, index) => index !== this.#focusedIndex)
				.reduce((widest, { element }) => {
					const aspect =
						element.videoHeight > 0
							? element.videoWidth / element.videoHeight
							: 0;
					return Number.isFinite(aspect) && aspect > 0
						? Math.max(widest, aspect)
						: widest;
				}, 0) || 16 / 9;
		this.#focusSidebarUserSized = false;
		this.#setFocusSidebarWidth(
			(height / previewRows) * widestPreviewAspect,
			false,
		);
	}

	#currentFocusSidebarWidth() {
		const { containerWidth } = this.#focusSidebarBounds();
		const explicit = Number.parseFloat(
			this.#elements.videos.style.getPropertyValue("--focus-sidebar-width"),
		);
		if (Number.isFinite(explicit) && explicit > 0) return explicit;
		const columns = getComputedStyle(this.#elements.videos)
			.gridTemplateColumns.trim()
			.split(/\s+/);
		const computed = Number.parseFloat(columns.at(-1) ?? "");
		return Number.isFinite(computed) && computed > 0
			? computed
			: Math.max(144, Math.min(containerWidth * 0.18, 288));
	}

	#updateFocusResizerValue(width: number) {
		const { containerWidth, minimum, maximum } = this.#focusSidebarBounds();
		const bounded = Math.max(minimum, Math.min(maximum, width));
		const percentage = Math.round((bounded / containerWidth) * 100);
		const focusedPercentage = 100 - percentage;
		this.#elements.focusResizer.setAttribute(
			"aria-valuemin",
			String(Math.round((minimum / containerWidth) * 100)),
		);
		this.#elements.focusResizer.setAttribute(
			"aria-valuemax",
			String(Math.round((maximum / containerWidth) * 100)),
		);
		this.#elements.focusResizer.setAttribute(
			"aria-valuenow",
			String(percentage),
		);
		this.#elements.focusResizer.setAttribute(
			"aria-valuetext",
			`${focusedPercentage}% focused view, ${percentage}% overview`,
		);
	}

	#setFocusSidebarWidth(width: number, userSized = true) {
		const { minimum, maximum } = this.#focusSidebarBounds();
		const bounded = Math.max(minimum, Math.min(maximum, width));
		this.#focusSidebarUserSized ||= userSized;
		this.#elements.videos.style.setProperty(
			"--focus-sidebar-width",
			`${Math.round(bounded)}px`,
		);
		this.#updateFocusResizerValue(bounded);
	}

	#resetFocusSidebarWidth() {
		this.#focusSidebarUserSized = false;
		this.#elements.videos.style.removeProperty("--focus-sidebar-width");
		requestAnimationFrame(() => {
			if (!this.#destroyed) this.#fitFocusSidebarWidth();
		});
	}

	#setLayout(layout: "focused" | "tiled") {
		this.#elements.videos.classList.toggle(
			"focused-layout",
			layout === "focused",
		);
		this.#elements.videos.classList.toggle("tiled", layout === "tiled");
		this.#elements.videos.dataset.layout = layout;
		const gridActive = layout === "tiled";
		this.#elements.focusResizer.hidden = gridActive;
		if (!gridActive) {
			requestAnimationFrame(() => {
				if (this.#destroyed) return;
				if (this.#focusSidebarUserSized) {
					this.#updateFocusResizerValue(this.#currentFocusSidebarWidth());
				} else {
					this.#fitFocusSidebarWidth();
				}
			});
		}
		setIconButton(
			this.#elements.layout,
			gridActive ? "Switch to Focus view (V)" : "Switch to Grid view (V)",
			gridActive ? "focus" : "grid",
		);
		this.#elements.layout.setAttribute("aria-pressed", String(gridActive));
	}

	async #requestFullscreen() {
		try {
			if (document.fullscreenElement === this.#elements.stage) {
				await document.exitFullscreen();
			} else {
				await this.#elements.stage.requestFullscreen();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			this.#setStatus(`Fullscreen failed: ${message}`, "error");
		}
	}

	async focusPov(index: number) {
		if (index === this.#focusedIndex || !this.#videos || !this.files[index])
			return;
		const referenceTimeUs = this.#referenceAtMaster();
		this.#focusedIndex = index;
		const preferredMaster = this.#preferredAudioMaster(referenceTimeUs);
		if (preferredMaster !== null) this.#setAudioMaster(preferredMaster);
		else this.#renderFocusState();
		if (!this.#focusSidebarUserSized) {
			requestAnimationFrame(() => {
				if (!this.#destroyed) this.#fitFocusSidebarWidth();
			});
		}

		this.#setStatus(
			this.#isCovered(index, referenceTimeUs)
				? `POV ${index + 1} focused${this.#audioMasterIndex === index ? " with audio" : ""}.`
				: `POV ${index + 1} focused but blank at this point; playback continues from covered POVs.`,
			this.#isCovered(index, referenceTimeUs) ? "success" : "warning",
		);
	}

	async #applyFinalOffset(index: number, offsetUs: number, detail: string) {
		if (index === this.#referenceIndex || !Number.isSafeInteger(offsetUs)) {
			this.#setStatus(
				"Offset target or value is outside the supported range.",
				"error",
			);
			return;
		}
		this.#finalOffsetsUs[index] = offsetUs;
		this.#setReferenceRange();
		this.#renderOffset();

		if (!(await this.seekReference(this.#currentReferenceTimeUs))) {
			return;
		}
		this.#setStatus(
			`POV ${index + 1} ${detail.toLowerCase()}: ${formatOffset(offsetUs)}.`,
			"success",
		);
	}

	#renderConfidence() {
		if (!this.#automatic) return;
		const needsReview = this.#automatic.alignments.some(
			({ candidates, confidence }) =>
				candidates.length === 0 || confidence !== "provisional",
		);
		const label = needsReview ? "Timing needs review" : "Timing provisional";
		setIconButton(this.#elements.timingOpen, label, "timing");
		this.#elements.timingOpen.removeAttribute("title");
		this.#elements.timingNotice.hidden = true;
		this.#elements.timingNotice.textContent = "";
		const text = document.createElement("span");
		text.textContent = label;
		this.#elements.timingOpen.append(text);
		this.#elements.timingOpen.hidden = false;
		this.#elements.timingOpen.dataset.tone = needsReview
			? "warning"
			: "neutral";
	}

	async #runAutomaticAlignment(resumeAfterAlignment = this.#isPlaying) {
		if (this.#audioSession || this.#destroyed) return;
		this.#alignmentOverallProgress = 0.15;
		this.#showAlignment();
		this.#elements.auto.disabled = true;
		this.#elements.timingOpen.removeAttribute("title");
		this.#elements.timingNotice.hidden = true;
		this.#elements.timingNotice.textContent = "";
		this.#setAlignmentProgress(
			`Inspecting ${this.files.length} local recordings`,
			0,
			this.files.length,
			0.15,
			0.25,
		);
		const followerIndexes = this.files
			.map((_, index) => index)
			.filter((index) => index !== this.#referenceIndex);
		const session = new AudioSyncSession(
			({ stage, completed, total, fileIndex, detail }) => {
				const fileLabel =
					fileIndex === null
						? ""
						: ` video ${fileIndex + 1} of ${this.files.length}`;
				const label =
					stage === "inspect"
						? `Inspecting${fileLabel}`
						: stage === "decode"
							? `Analyzing audio for${fileLabel}`
							: stage === "search"
								? `Comparing shared audio for${fileLabel}`
								: `Checking shared screen sequence for${fileLabel}`;
				let overallStart = stage === "inspect" ? 0.15 : 0.25;
				let overallEnd = stage === "inspect" ? 0.25 : 0.45;
				let progressCompleted = completed;
				let progressTotal = total;
				if (stage === "search" || stage === "refine") {
					const ordinal = Math.max(0, followerIndexes.indexOf(fileIndex ?? -1));
					const segmentWidth = 0.5 / Math.max(1, followerIndexes.length);
					const segmentStart = 0.45 + ordinal * segmentWidth;
					const finalFollowerUpdate = detail.startsWith(
						"Ranked audio candidates",
					);
					if (stage === "search") {
						overallStart = segmentStart;
						overallEnd = segmentStart + segmentWidth * 0.1;
					} else if (finalFollowerUpdate) {
						overallStart = segmentStart;
						overallEnd = segmentStart + segmentWidth;
						progressCompleted = 1;
						progressTotal = 1;
					} else {
						overallStart = segmentStart + segmentWidth * 0.1;
						overallEnd = segmentStart + segmentWidth * 0.4;
					}
				}
				this.#setAlignmentProgress(
					label,
					progressCompleted,
					progressTotal,
					overallStart,
					overallEnd,
				);
			},
		);
		this.#audioSession = session;
		const referenceIndex = this.#referenceIndex;

		try {
			const result = await session.run(this.files, referenceIndex);
			this.#releaseAudioSession(session);
			if (referenceIndex !== this.#referenceIndex || this.#destroyed) return;
			this.#automatic = result;
			this.#automaticOffsetsUs = this.files.map((_, index) =>
				index === referenceIndex ? 0 : null,
			);
			for (const alignment of result.alignments) {
				const top = alignment.candidates[0];
				if (!top) continue;
				const suggestedOffsetUs = candidatePlaybackOffsetUs(top);
				this.#automaticOffsetsUs[alignment.followerIndex] = suggestedOffsetUs;
				this.#finalOffsetsUs[alignment.followerIndex] = suggestedOffsetUs;
			}
			this.#setAlignmentProgress("Synchronization complete", 1, 1);
			const estimatedCount = result.alignments.filter(
				({ candidates }) => candidates.length > 0,
			).length;
			const missingCount = result.alignments.length - estimatedCount;
			const reviewCount = result.alignments.filter(
				({ candidates, confidence }) =>
					candidates.length > 0 && confidence !== "provisional",
			).length;
			const completionMessage =
				missingCount > 0
					? `Synchronization complete. ${missingCount} POV${missingCount === 1 ? "" : "s"} need manual timing.`
					: reviewCount > 0
						? `Synchronization complete. Review ${reviewCount} low-confidence POV${reviewCount === 1 ? "" : "s"}.`
						: "Synchronization complete. Provisional automatic timing applied.";
			this.#setReferenceRange();
			this.#renderConfidence();

			this.#renderOffset();

			const initialSeekSucceeded = await this.seekReference(
				this.#currentReferenceTimeUs,
			);
			if (initialSeekSucceeded) {
				this.#setStatus(
					completionMessage,
					missingCount === 0 && reviewCount === 0 ? "success" : "warning",
				);
			}
		} catch (error) {
			let label = "Adjust timing manually";
			let notice =
				"Automatic synchronization was cancelled. Set the offset manually or retry.";
			if (error instanceof DOMException && error.name === "AbortError") {
				this.#elements.autoProgress.textContent = "Synchronization cancelled.";
				this.#setStatus(
					"Synchronization cancelled; manual timing remains available.",
					"warning",
				);
			} else {
				const message = error instanceof Error ? error.message : String(error);
				label = "Automatic timing failed";
				notice = `Automatic synchronization failed: ${message}. Set the offset manually or retry.`;

				this.#elements.autoProgress.textContent = `Synchronization failed: ${message}`;
				this.#setStatus(notice, "error");
			}
			if (!this.#destroyed) {
				setIconButton(this.#elements.timingOpen, label, "timing");
				const text = document.createElement("span");
				text.textContent = label;
				this.#elements.timingOpen.append(text);
				this.#elements.timingOpen.hidden = false;
				this.#elements.timingOpen.dataset.tone = "warning";
				this.#elements.timingOpen.title = notice;
				this.#elements.timingNotice.textContent = notice;
				this.#elements.timingNotice.hidden = false;
			}
		} finally {
			this.#releaseAudioSession(session);
			this.#elements.auto.disabled = false;

			this.#showPlayer();
			if (resumeAfterAlignment && !this.#destroyed) await this.play(false);
		}
	}

	#releaseAudioSession(session: AudioSyncSession) {
		if (this.#audioSession !== session) return;
		this.#audioSession = null;
	}

	#startFrameObservation() {
		const videos = this.#videos;
		if (!videos) return;
		for (const [index, { element }] of videos.entries()) {
			const observe = () => {
				if (this.#destroyed) return;
				if (index === this.#audioMasterIndex) this.#observePlayback();
				this.#frameCallbackIds[index] =
					element.requestVideoFrameCallback(observe);
			};
			this.#frameCallbackIds[index] =
				element.requestVideoFrameCallback(observe);
		}
		this.#clockTimer = window.setInterval(() => {
			if (this.#destroyed) return;
			if (this.#isPlaying) this.#observePlayback();
			else this.#renderTimeline();
		}, 125);
	}

	#observePlayback() {
		const videos = this.#videos;
		if (this.#scrubbing) return;
		if (!videos) return;
		let masterIndex = this.#audioMasterIndex;
		if (!this.#isCovered(masterIndex)) {
			const fallback = this.#preferredAudioMaster(this.#currentReferenceTimeUs);
			if (fallback !== null) {
				this.#setAudioMaster(fallback);
				masterIndex = fallback;
			}
		}
		const referenceTimeUs = this.#referenceAtMaster();
		this.#currentReferenceTimeUs = referenceTimeUs;
		this.#renderTimeline();
		if (!this.#isPlaying) return;

		for (const [index, { element }] of videos.entries()) {
			if (index === masterIndex || this.#correctionBusy.has(index)) continue;
			const expectedLocalUs = referenceToLocalUs(
				referenceTimeUs,
				this.#offsetFor(index),
			);
			if (!isLocalTimeCovered(expectedLocalUs, this.#durationUs(index))) {
				if (!element.paused) element.pause();
				continue;
			}
			if (element.paused && !element.ended) {
				this.#correctionBusy.add(index);
				void waitForSeek(element, microsecondsToSeconds(expectedLocalUs))
					.then(() => {
						if (this.#isPlaying) return element.play();
					})
					.catch((error) => {
						const message =
							error instanceof Error ? error.message : String(error);
						this.#setStatus(
							`Could not resume POV ${index + 1}: ${message}`,
							"error",
						);
					})
					.finally(() => this.#correctionBusy.delete(index));
				continue;
			}

			const driftUs =
				secondsToMicroseconds(element.currentTime) - expectedLocalUs;
			const absoluteDriftUs = Math.abs(driftUs);
			if (absoluteDriftUs <= DRIFT_JITTER_US) {
				element.playbackRate = this.#playbackSpeed;
				this.#stableDriftCounts[index] = 0;
				this.#stableDriftSigns[index] = 0;
				continue;
			}

			const sign = Math.sign(driftUs);
			if (sign === (this.#stableDriftSigns[index] ?? 0)) {
				this.#stableDriftCounts[index] =
					(this.#stableDriftCounts[index] ?? 0) + 1;
			} else {
				this.#stableDriftSigns[index] = sign;
				this.#stableDriftCounts[index] = 1;
			}
			const now = performance.now();
			if (
				(this.#stableDriftCounts[index] ?? 0) < 3 ||
				now - (this.#lastCorrectionAt[index] ?? Number.NEGATIVE_INFINITY) <
					CORRECTION_COOLDOWN_MS
			) {
				continue;
			}
			this.#lastCorrectionAt[index] = now;
			if (absoluteDriftUs >= DRIFT_SEEK_US) {
				const recentSeekCorrections = (
					this.#seekCorrectionTimestamps[index] ?? []
				).filter((timestamp) => now - timestamp < 30_000);
				this.#seekCorrectionTimestamps[index] = recentSeekCorrections;
				if (
					recentSeekCorrections.length >=
					MAXIMUM_CORRECTION_SEEKS_PER_POV_30_SECONDS
				) {
					this.pause("Synchronization correction limit reached.");
					this.#setStatus(
						`Playback paused because POV ${index + 1} required repeated correction seeks.`,
						"error",
					);
					return;
				}
				recentSeekCorrections.push(now);
				this.#correctionBusy.add(index);

				void waitForSeek(element, microsecondsToSeconds(expectedLocalUs))
					.then(() => {
						if (this.#isPlaying) return element.play();
					})
					.catch((error) => {
						const message =
							error instanceof Error ? error.message : String(error);
						this.#setStatus(
							`POV ${index + 1} correction failed: ${message}`,
							"error",
						);

						this.pause("Synchronization correction failed.");
					})
					.finally(() => this.#correctionBusy.delete(index));
				this.#setStatus(
					`Visible correction seek: POV ${index + 1} drifted ${formatOffset(driftUs)}.`,
					"warning",
				);
			} else {
				const adjustment = Math.max(-0.02, Math.min(0.02, driftUs / 2_000_000));
				element.playbackRate = this.#playbackSpeed * (1 - adjustment);
			}
		}
	}

	#resetDriftBaseline() {
		this.#stableDriftCounts.fill(0);
		this.#stableDriftSigns.fill(0);
		this.#lastCorrectionAt.fill(Number.NEGATIVE_INFINITY);
		for (const timestamps of this.#seekCorrectionTimestamps)
			timestamps.length = 0;
		for (const { element } of this.#videos ?? [])
			element.playbackRate = this.#playbackSpeed;
	}

	#onMediaEnded(index: number) {
		if (index !== this.#audioMasterIndex || !this.#isPlaying) return;
		const fallback = this.#preferredAudioMaster(this.#currentReferenceTimeUs);
		if (fallback !== null && fallback !== index) {
			this.#setAudioMaster(fallback);
			return;
		}
		this.#setStatus(
			`POV ${index + 1} audio ended; covered video continues silently until another audio POV is available.`,
			"warning",
		);
	}

	async destroy() {
		if (this.#destroyed) return;
		this.#destroyed = true;
		this.#prepareAbort.abort();
		this.#isPlaying = false;
		this.#seekRequestSequence += 1;
		this.#pendingSeekTargetUs = null;
		this.#resumeAfterPendingSeek = false;
		window.clearTimeout(this.#controlsHideTimer);
		window.clearTimeout(this.#singleClickTimer);
		if (this.#elements.helpDialog.open) this.#elements.helpDialog.close();
		if (this.#elements.timingDialog.open) this.#elements.timingDialog.close();
		window.removeEventListener("keydown", this.#onKeyDown);
		window.removeEventListener("resize", this.#onWindowResize);
		this.#focusResizeObserver?.disconnect();
		this.#focusResizeObserver = null;
		document.removeEventListener("fullscreenchange", this.#onFullscreenChange);
		if (document.fullscreenElement === this.#elements.stage) {
			try {
				await document.exitFullscreen();
			} catch {}
		}
		const provisionalAudioContext = this.#audioProvisionalContext;
		if (provisionalAudioContext) {
			await this.#closeAudioContext(provisionalAudioContext);
			if (this.#audioProvisionalContext === provisionalAudioContext) {
				this.#audioProvisionalContext = null;
			}
		}
		window.clearInterval(this.#clockTimer);
		for (const [index, video] of this.#videos?.entries() ?? []) {
			const callbackId = this.#frameCallbackIds[index];
			if (callbackId !== null && callbackId !== undefined) {
				video.element.cancelVideoFrameCallback(callbackId);
			}
		}
		const audioSession = this.#audioSession;
		if (audioSession) {
			await audioSession.cancel();
			this.#releaseAudioSession(audioSession);
		}
		const audioSetup = this.#audioSetup;
		if (audioSetup) await audioSetup;
		await this.#closeAudioOutput();
		if (this.#videos) {
			cleanupVideos(this.#videos);
			this.#videos = null;
		}

		this.host.replaceChildren();
	}
}
