export type PreparedVideo = {
	file: File;
	url: string;
	element: HTMLVideoElement;
};

export type VideoPreparationProgress = {
	inputIndex: number;
	completed: number;
	total: number;
	status: "preparing" | "ready" | "failed";
};

type VideoPreparationFailure = {
	inputIndex: number;
	name: string;
	status: "unsupported";
	error: string;
};

function waitForMediaEvent(
	element: HTMLMediaElement,
	successEvent: keyof HTMLMediaElementEventMap,
	timeoutMilliseconds = 10_000,
	signal?: AbortSignal,
) {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const cleanup = () => {
		window.clearTimeout(timeout);
		element.removeEventListener(successEvent, onSuccess);
		element.removeEventListener("error", onError);
		signal?.removeEventListener("abort", onAbort);
	};
	const onSuccess = () => {
		cleanup();
		resolve();
	};
	const onError = () => {
		cleanup();
		reject(
			new Error(
				element.error?.message ??
					`Media error ${element.error?.code ?? "unknown"}`,
			),
		);
	};
	const onAbort = () => {
		cleanup();
		reject(
			signal?.reason ??
				new DOMException("Media preparation cancelled", "AbortError"),
		);
	};
	const timeout = window.setTimeout(() => {
		cleanup();
		reject(new Error(`Timed out waiting for ${successEvent}`));
	}, timeoutMilliseconds);
	element.addEventListener(successEvent, onSuccess, { once: true });
	element.addEventListener("error", onError, { once: true });
	signal?.addEventListener("abort", onAbort, { once: true });
	if (signal?.aborted) onAbort();
	return promise;
}

export async function prepareVideos(
	files: readonly File[],
	container: HTMLElement,
	signal?: AbortSignal,
	onProgress?: (progress: VideoPreparationProgress) => void,
) {
	const videos: PreparedVideo[] = [];
	const failures: VideoPreparationFailure[] = [];
	for (const [inputIndex, file] of files.entries()) {
		onProgress?.({
			inputIndex,
			completed: inputIndex,
			total: files.length,
			status: "preparing",
		});
		const url = URL.createObjectURL(file);
		const element = document.createElement("video");
		element.controls = true;
		element.muted = true;
		element.preload = "metadata";
		element.src = url;
		container.append(element);
		const prepared: PreparedVideo = { file, url, element };
		try {
			await waitForMediaEvent(element, "loadedmetadata", 10_000, signal);
			videos.push(prepared);
			onProgress?.({
				inputIndex,
				completed: inputIndex + 1,
				total: files.length,
				status: "ready",
			});
		} catch (error) {
			cleanupVideos([prepared]);
			if (signal?.aborted) {
				cleanupVideos(videos);
				throw error;
			}
			failures.push({
				inputIndex,
				name: file.name,
				status: "unsupported",
				error: error instanceof Error ? error.message : String(error),
			});
			onProgress?.({
				inputIndex,
				completed: inputIndex + 1,
				total: files.length,
				status: "failed",
			});
		}
	}
	return { videos, failures };
}

export function cleanupVideos(videos: readonly PreparedVideo[]) {
	for (const { element, url } of videos) {
		element.pause();
		element.removeAttribute("src");
		element.load();
		element.remove();
		URL.revokeObjectURL(url);
	}
}
