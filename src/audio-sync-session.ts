import type {
	AudioSyncProgress,
	AudioSyncResult,
	AudioSyncWorkerRequest,
	AudioSyncWorkerResponse,
} from "./sync-types";

export const AUDIO_SYNC_CANCELLATION_DEADLINE_MS = 250;

export type AudioSyncCancellationResult = {
	state: "acknowledged" | "forced" | "idle" | "settled";
	elapsedMilliseconds: number;
	queueHighWater: number | null;
	audioSamplesClosed: number;
	videoSamplesClosed: number;
	workerTerminated: boolean;
};

export class AudioSyncSession {
	#worker: Worker | null = null;
	#id = "";
	#rejectRun: ((reason?: unknown) => void) | null = null;
	#resolveCancellation: ((result: AudioSyncCancellationResult) => void) | null =
		null;
	#cancellationPromise: Promise<AudioSyncCancellationResult> | null = null;
	#cancellationStarted = 0;
	#cancellationTimeout = 0;
	#settledSamplesClosed = 0;
	#settledVideoSamplesClosed = 0;

	constructor(readonly onProgress: (progress: AudioSyncProgress) => void) {}

	#settleCancellation(queueHighWater: number | null) {
		if (!this.#resolveCancellation) return;
		window.clearTimeout(this.#cancellationTimeout);
		const resolve = this.#resolveCancellation;
		this.#resolveCancellation = null;
		this.#cancellationPromise = null;
		resolve({
			state: "settled",
			elapsedMilliseconds: performance.now() - this.#cancellationStarted,
			queueHighWater,
			audioSamplesClosed: this.#settledSamplesClosed,
			videoSamplesClosed: this.#settledVideoSamplesClosed,
			workerTerminated: true,
		});
	}

	run(files: readonly File[], referenceIndex: number) {
		if (this.#worker)
			throw new Error("Audio synchronization is already active");
		if (files.length < 2 || files.length > 6)
			throw new Error("Select between two and six files");
		if (
			!Number.isInteger(referenceIndex) ||
			referenceIndex < 0 ||
			referenceIndex >= files.length
		) {
			throw new Error("Reference POV is outside the selected file range");
		}

		this.#id = crypto.randomUUID();
		this.#worker = new Worker(
			new URL("./audio-sync-worker.ts", import.meta.url),
			{
				type: "module",
			},
		);
		const { promise, resolve, reject } =
			Promise.withResolvers<AudioSyncResult>();
		this.#rejectRun = reject;

		this.#worker.addEventListener(
			"message",
			(event: MessageEvent<AudioSyncWorkerResponse>) => {
				if (event.data.id !== this.#id) return;
				if (event.data.type === "progress") {
					this.onProgress(event.data);
					return;
				}
				if (event.data.type === "cancelled") {
					window.clearTimeout(this.#cancellationTimeout);
					const elapsedMilliseconds =
						performance.now() - this.#cancellationStarted;
					this.#settledSamplesClosed = event.data.audioSamplesClosed;
					this.#settledVideoSamplesClosed = event.data.videoSamplesClosed;
					this.#worker?.terminate();
					this.#worker = null;
					this.#resolveCancellation?.({
						state: "acknowledged",
						elapsedMilliseconds,
						queueHighWater: event.data.queueHighWater,
						audioSamplesClosed: event.data.audioSamplesClosed,
						videoSamplesClosed: event.data.videoSamplesClosed,
						workerTerminated: true,
					});
					this.#resolveCancellation = null;
					this.#cancellationPromise = null;
					this.#rejectRun?.(
						new DOMException("Audio synchronization cancelled", "AbortError"),
					);
					this.#rejectRun = null;
					return;
				}
				if (event.data.type === "error") {
					this.#settleCancellation(null);
					this.#worker?.terminate();
					this.#worker = null;
					this.#rejectRun = null;
					reject(new Error(event.data.message));
					return;
				}

				this.#settledSamplesClosed =
					event.data.result.cleanup.audioSamplesClosed;
				this.#settledVideoSamplesClosed =
					event.data.result.cleanup.videoSamplesClosed;
				this.#settleCancellation(event.data.result.queueHighWater);
				this.#worker?.terminate();
				this.#worker = null;
				this.#rejectRun = null;
				resolve(event.data.result);
			},
		);

		this.#worker.addEventListener("error", (event) => {
			this.#settleCancellation(null);
			this.#worker?.terminate();
			this.#worker = null;
			this.#rejectRun = null;
			reject(new Error(event.message || "Audio synchronization worker failed"));
		});

		const request: AudioSyncWorkerRequest = {
			id: this.#id,
			type: "align",
			files: [...files],
			referenceIndex,
		};
		this.#worker.postMessage(request);
		return promise;
	}

	cancel() {
		if (this.#cancellationPromise) return this.#cancellationPromise;
		if (!this.#worker) {
			return Promise.resolve<AudioSyncCancellationResult>({
				state: "idle",
				elapsedMilliseconds: 0,
				queueHighWater: null,
				audioSamplesClosed: this.#settledSamplesClosed,
				videoSamplesClosed: this.#settledVideoSamplesClosed,
				workerTerminated: true,
			});
		}

		const { promise, resolve } =
			Promise.withResolvers<AudioSyncCancellationResult>();
		this.#resolveCancellation = resolve;
		this.#cancellationPromise = promise;
		this.#cancellationStarted = performance.now();
		const request: AudioSyncWorkerRequest = { id: this.#id, type: "cancel" };
		this.#worker.postMessage(request);
		this.#cancellationTimeout = window.setTimeout(() => {
			const elapsedMilliseconds = performance.now() - this.#cancellationStarted;
			this.#worker?.terminate();
			this.#worker = null;
			this.#resolveCancellation?.({
				state: "forced",
				elapsedMilliseconds,
				queueHighWater: null,
				audioSamplesClosed: this.#settledSamplesClosed,
				videoSamplesClosed: this.#settledVideoSamplesClosed,
				workerTerminated: true,
			});
			this.#resolveCancellation = null;
			this.#cancellationPromise = null;
			this.#rejectRun?.(
				new DOMException(
					"Audio synchronization cancellation timed out",
					"AbortError",
				),
			);
			this.#rejectRun = null;
		}, AUDIO_SYNC_CANCELLATION_DEADLINE_MS);
		return promise;
	}
}
