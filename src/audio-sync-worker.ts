import {
	AudioSampleSink,
	BlobSource,
	Input,
	type InputAudioTrack,
	type InputVideoTrack,
	MATROSKA,
	MP4,
	type VideoSample,
	VideoSampleSink,
	WEBM,
} from "mediabunny";
import {
	type AudioFeaturePair,
	type AudioFeatureSeries,
	alignAudioFeatures,
	DEFAULT_AUDIO_SYNC_CONFIG,
	selectVisualTiebreakCandidate,
} from "./audio-sync";
import { ByteRangeCounter } from "./ranges";
import type {
	AudioSyncAlignment,
	AudioSyncResult,
	AudioSyncWorkerRequest,
	AudioSyncWorkerResponse,
	SyncCandidate,
	SyncFileDescriptor,
	SyncTrackDescriptor,
	VisualCandidateEvidence,
} from "./sync-types";
import { secondsToMicroseconds } from "./timeline";
import {
	aggregateVisualWindows,
	compareVisualSequences,
	DEFAULT_VISUAL_SEQUENCE_CONFIG,
	describeVisualFrame,
	type VisualFrameDescriptor,
	type VisualSequenceComparison,
	type VisualWindowAggregate,
} from "./visual-sequence";

const MAXIMUM_TRACKS_PER_FILE = 16;
const MAXIMUM_DURATION_US = 8 * 60 * 60 * 1_000_000;
const PCM_SAMPLE_RATE_HZ = 8_000;
const MAXIMUM_VISUAL_FRAMES_PER_CANDIDATE =
	DEFAULT_VISUAL_SEQUENCE_CONFIG.windowCount *
	DEFAULT_VISUAL_SEQUENCE_CONFIG.framesPerWindow *
	(1 + DEFAULT_VISUAL_SEQUENCE_CONFIG.coarseOffsetAdjustmentsUs.length + 2);

type ActiveAlignment = {
	id: string;
	cancelled: boolean;
	inputs: Set<Input>;
	queueHighWater: number;
	audioSamplesClosed: number;
	videoSamplesClosed: number;
};

type OpenFile = {
	file: File;
	input: Input;
	ranges: ByteRangeCounter;
	descriptor: SyncFileDescriptor;
	audioTracks: InputAudioTrack[];
	videoTrack: InputVideoTrack | null;
};

type ExtractedTrack = {
	descriptor: SyncTrackDescriptor;
	feature: AudioFeatureSeries;
};

let active: ActiveAlignment | undefined;

function send(message: AudioSyncWorkerResponse) {
	postMessage(message);
}

function progress(
	stage: Extract<AudioSyncWorkerResponse, { type: "progress" }>["stage"],
	completed: number,
	total: number,
	fileIndex: number | null,
	detail: string,
) {
	if (!active) return;
	send({
		id: active.id,
		type: "progress",
		stage,
		completed,
		total,
		fileIndex,
		detail,
	});
}

function assertActive() {
	if (!active || active.cancelled)
		throw new DOMException("Audio alignment cancelled", "AbortError");
	return active;
}

async function openFile(file: File, fileIndex: number): Promise<OpenFile> {
	const state = assertActive();
	const ranges = new ByteRangeCounter();
	const source = new BlobSource(file, { maxCacheSize: 1024 * 1024 });
	source.on("read", ({ start, end }) => ranges.add(start, end));
	const input = new Input({ formats: [MP4, MATROSKA, WEBM], source });
	state.inputs.add(input);
	if (!(await input.canRead())) {
		throw new Error(
			`${file.name}: container is not supported (expected MP4, WebM, or MKV)`,
		);
	}
	const [
		format,
		durationSeconds,
		firstTimestampSeconds,
		audioTracks,
		videoTracks,
	] = await Promise.all([
		input.getFormat(),
		input.getDurationFromMetadata(undefined, { skipLiveWait: true }),
		input.getFirstTimestamp(),
		input.getAudioTracks(),
		input.getVideoTracks(),
	]);
	if (audioTracks.length > MAXIMUM_TRACKS_PER_FILE) {
		throw new Error(
			`${file.name}: ${audioTracks.length} audio tracks exceeds the bounded limit of ${MAXIMUM_TRACKS_PER_FILE}`,
		);
	}
	const decodable = await Promise.all(
		audioTracks.map((track) => track.canDecode()),
	);
	const usableAudioTracks = audioTracks.filter(
		(_track, index) => decodable[index],
	);
	const candidateVideoTracks = videoTracks.slice(0, MAXIMUM_TRACKS_PER_FILE);
	const videoDecodable = await Promise.all(
		candidateVideoTracks.map((track) => track.canDecode()),
	);
	const videoTrack =
		candidateVideoTracks.find(
			(_track, index) => videoDecodable[index] === true,
		) ?? null;
	const durationUs = secondsToMicroseconds(durationSeconds ?? 0);
	if (durationUs > MAXIMUM_DURATION_US) {
		throw new Error(
			`${file.name}: duration exceeds the bounded eight-hour analysis limit`,
		);
	}
	return {
		file,
		input,
		ranges,
		audioTracks: usableAudioTracks,
		videoTrack,
		descriptor: {
			fileIndex,
			name: file.name,
			sizeBytes: file.size,
			declaredMimeType: file.type,
			format: format.name,
			formatMimeType: format.mimeType,
			durationUs,
			playbackOrigin: {
				rawTimestampAtMediaTimeZeroUs: secondsToMicroseconds(
					firstTimestampSeconds,
				),
				source: "container-first-timestamp",
			},
			tracks: [],
			reads: {
				requests: 0,
				requestedBytes: 0,
				uniqueBytes: 0,
				uniqueBytesExact: true,
				rangesTruncated: false,
				percentOfFile: 0,
				ranges: [],
			},
			inputDisposed: false,
		},
	};
}

function growFloat64(
	values: Float64Array<ArrayBuffer>,
	minimumLength: number,
): Float64Array<ArrayBuffer> {
	if (minimumLength <= values.length) return values;
	let length = Math.max(1_024, values.length);
	while (length < minimumLength) length *= 2;
	const grown = new Float64Array(length);
	grown.set(values);
	return grown;
}

function growUint32(
	values: Uint32Array<ArrayBuffer>,
	minimumLength: number,
): Uint32Array<ArrayBuffer> {
	if (minimumLength <= values.length) return values;
	let length = Math.max(1_024, values.length);
	while (length < minimumLength) length *= 2;
	const grown = new Uint32Array(length);
	grown.set(values);
	return grown;
}

async function extractTrack(
	file: OpenFile,
	track: InputAudioTrack,
	trackProgressIndex: number,
	totalTracks: number,
): Promise<ExtractedTrack> {
	const [
		canDecode,
		codec,
		codecParameter,
		language,
		name,
		channels,
		sampleRate,
		firstTimestamp,
	] = await Promise.all([
		track.canDecode(),
		track.getCodec(),
		track.getCodecParameterString(),
		track.getLanguageCode(),
		track.getName(),
		track.getNumberOfChannels(),
		track.getSampleRate(),
		track.getFirstTimestamp(),
	]);
	if (!canDecode)
		throw new Error(
			`${file.file.name}: audio track ${track.number} cannot be decoded`,
		);

	const firstTimestampUs = secondsToMicroseconds(firstTimestamp);
	const binUs = DEFAULT_AUDIO_SYNC_CONFIG.fineFeatureBinUs;
	const estimatedBins = Math.max(
		1_024,
		Math.ceil(Math.max(0, file.descriptor.durationUs) / binUs) + 4,
	);
	let squareSums = new Float64Array(estimatedBins);
	let absoluteSums = new Float64Array(estimatedBins);
	let counts = new Uint32Array(estimatedBins);
	let channelData = new Float32Array(0);
	let lastUsedIndex = -1;
	let lastProgressTimestamp = Number.NEGATIVE_INFINITY;
	let samplesClosed = 0;
	const stride = Math.max(1, Math.floor(sampleRate / PCM_SAMPLE_RATE_HZ));
	const sink = new AudioSampleSink(track);

	progress(
		"decode",
		trackProgressIndex,
		totalTracks,
		file.descriptor.fileIndex,
		`Decoding ${file.file.name} audio track ${track.number}`,
	);
	for await (const sample of sink.samples()) {
		try {
			assertActive();
			if (channelData.length < sample.numberOfFrames) {
				channelData = new Float32Array(sample.numberOfFrames);
			}
			for (let channel = 0; channel < sample.numberOfChannels; channel += 1) {
				sample.copyTo(channelData, {
					planeIndex: channel,
					format: "f32-planar",
				});
				for (let frame = 0; frame < sample.numberOfFrames; frame += stride) {
					const timestampUs = secondsToMicroseconds(
						sample.timestamp + frame / sample.sampleRate,
					);
					const featureIndex = Math.floor(
						(timestampUs - firstTimestampUs) / binUs,
					);
					if (featureIndex < 0) continue;
					if (featureIndex * binUs > MAXIMUM_DURATION_US) {
						throw new Error(
							`${file.file.name}: decoded audio exceeds the bounded eight-hour limit`,
						);
					}
					squareSums = growFloat64(squareSums, featureIndex + 1);
					absoluteSums = growFloat64(absoluteSums, featureIndex + 1);
					counts = growUint32(counts, featureIndex + 1);
					const value = channelData[frame] ?? 0;
					squareSums[featureIndex] =
						(squareSums[featureIndex] ?? 0) + value * value;
					absoluteSums[featureIndex] =
						(absoluteSums[featureIndex] ?? 0) + Math.abs(value);
					counts[featureIndex] = (counts[featureIndex] ?? 0) + 1;
					lastUsedIndex = Math.max(lastUsedIndex, featureIndex);
				}
			}
			if (sample.timestamp - lastProgressTimestamp >= 5) {
				lastProgressTimestamp = sample.timestamp;
				progress(
					"decode",
					trackProgressIndex,
					totalTracks,
					file.descriptor.fileIndex,
					`${file.file.name} track ${track.number}: ${Math.max(0, sample.timestamp - firstTimestamp).toFixed(0)} s decoded`,
				);
			}
		} finally {
			sample.close();
			samplesClosed += 1;
			if (active) active.audioSamplesClosed += 1;
		}
	}

	const featureCount = lastUsedIndex + 1;
	const logEnergy = new Float32Array(featureCount);
	for (let index = 0; index < featureCount; index += 1) {
		const count = counts[index] ?? 0;
		if (count === 0) continue;
		const rms = Math.sqrt((squareSums[index] ?? 0) / count);
		const meanAbsolute = (absoluteSums[index] ?? 0) / count;
		logEnergy[index] = Math.log1p(1_000 * (0.7 * rms + 0.3 * meanAbsolute));
	}
	const values = new Float32Array(featureCount);
	let maximum = 0;
	for (let index = 0; index < featureCount; index += 1) {
		const current = logEnergy[index] ?? 0;
		const previous = logEnergy[index - 1] ?? current;
		const onset = Math.max(0, current - previous);
		const featureValue =
			onset + 0.2 * Math.abs(current - previous) + 0.05 * current;
		values[index] = featureValue;
		maximum = Math.max(maximum, featureValue);
	}
	let activeFeatureCount = 0;
	const activityFloor = Math.max(1e-6, maximum * 0.03);
	for (const value of values)
		if (value >= activityFloor) activeFeatureCount += 1;

	const durationUs = Math.max(file.descriptor.durationUs, featureCount * binUs);
	const descriptor: SyncTrackDescriptor = {
		fileIndex: file.descriptor.fileIndex,
		id: track.id,
		number: track.number,
		codec,
		codecParameter,
		language,
		name,
		channels,
		sampleRateHz: sampleRate,
		rawFirstTimestampUs: firstTimestampUs,
		durationUs,
		featureBinUs: binUs,
		featureCount,
		activeFeatureCount,
		samplesClosed,
	};
	return {
		descriptor,
		feature: {
			trackId: track.id,
			values,
			startTimestampUs: firstTimestampUs,
			binUs,
			activeFeatureCount,
		},
	};
}

function visualEvidence(
	candidate: SyncCandidate,
	status: VisualCandidateEvidence["status"],
	evidence: string,
): VisualCandidateEvidence {
	return {
		status,
		descriptor: "tiled-luma-color-gradient-v1",
		sequence: "ordered-banded-v1",
		similarity: null,
		spatialSimilarity: null,
		transitionSimilarity: null,
		audioOffsetUs: candidate.offsetUs,
		refinedOffsetUs: null,
		selectedOffsetAdjustmentUs: 0,
		framesRequested: 0,
		framesCompared: 0,
		sampleReferenceTimesUs: [],
		windows: [],
		bounds: {
			maximumCandidates: DEFAULT_VISUAL_SEQUENCE_CONFIG.maximumCandidates,
			maximumFramesPerCandidate: MAXIMUM_VISUAL_FRAMES_PER_CANDIDATE,
			maximumConcurrentDecodes: 1,
		},
		evidence,
	};
}

function describeFrame(
	sample: VideoSample,
	context: OffscreenCanvasRenderingContext2D,
	rawTimestampUs: number,
) {
	const { descriptorWidth, descriptorHeight } = DEFAULT_VISUAL_SEQUENCE_CONFIG;
	context.clearRect(0, 0, descriptorWidth, descriptorHeight);
	sample.draw(context, 0, 0, descriptorWidth, descriptorHeight);
	const pixels = context.getImageData(
		0,
		0,
		descriptorWidth,
		descriptorHeight,
	).data;
	return describeVisualFrame(
		pixels,
		descriptorWidth,
		descriptorHeight,
		rawTimestampUs,
	);
}

async function descriptorAt(
	sink: VideoSampleSink,
	rawTimestampUs: number,
	context: OffscreenCanvasRenderingContext2D,
) {
	assertActive();
	const sample = await sink.getSample(rawTimestampUs / 1_000_000);
	if (!sample) return null;
	try {
		return describeFrame(sample, context, rawTimestampUs);
	} finally {
		sample.close();
		if (active) active.videoSamplesClosed += 1;
	}
}

type ScoredVisualShift = {
	offsetAdjustmentUs: number;
	aggregate: VisualWindowAggregate;
	comparisons: VisualSequenceComparison[];
	referenceTimesByWindow: number[][];
};

async function scoreVisualCandidate(
	reference: OpenFile,
	follower: OpenFile,
	candidate: SyncCandidate,
	referenceSink: VideoSampleSink,
	followerSink: VideoSampleSink,
	context: OffscreenCanvasRenderingContext2D,
): Promise<VisualCandidateEvidence> {
	const overlapStartUs = Math.max(0, candidate.offsetUs);
	const overlapEndUs = Math.min(
		reference.descriptor.durationUs,
		candidate.offsetUs + follower.descriptor.durationUs,
	);
	const halfWindowUs =
		Math.floor(DEFAULT_VISUAL_SEQUENCE_CONFIG.framesPerWindow / 2) *
		DEFAULT_VISUAL_SEQUENCE_CONFIG.sampleIntervalUs;
	const firstAnchorUs = overlapStartUs + halfWindowUs;
	const lastAnchorUs = overlapEndUs - halfWindowUs;
	if (lastAnchorUs - firstAnchorUs < 1_000_000) {
		return visualEvidence(
			candidate,
			"unavailable",
			"The candidate has too little shared playback range for distributed ordered sequences.",
		);
	}

	const anchors = Array.from(
		{ length: DEFAULT_VISUAL_SEQUENCE_CONFIG.windowCount },
		(_value, index) =>
			Math.round(
				firstAnchorUs +
					((lastAnchorUs - firstAnchorUs) * (index + 1)) /
						(DEFAULT_VISUAL_SEQUENCE_CONFIG.windowCount + 1),
			),
	);
	const referenceTimesByWindow = anchors.map((anchorUs) =>
		Array.from(
			{ length: DEFAULT_VISUAL_SEQUENCE_CONFIG.framesPerWindow },
			(_value, index) =>
				anchorUs +
				(index -
					Math.floor(DEFAULT_VISUAL_SEQUENCE_CONFIG.framesPerWindow / 2)) *
					DEFAULT_VISUAL_SEQUENCE_CONFIG.sampleIntervalUs,
		),
	);
	const referenceCache = new Map<number, VisualFrameDescriptor | null>();
	const followerCache = new Map<number, VisualFrameDescriptor | null>();
	let framesRequested = 0;

	const loadDescriptor = async (
		cache: Map<number, VisualFrameDescriptor | null>,
		sink: VideoSampleSink,
		rawTimestampUs: number,
	) => {
		const cached = cache.get(rawTimestampUs);
		if (cached !== undefined || cache.has(rawTimestampUs))
			return cached ?? null;
		framesRequested += 1;
		const descriptor = await descriptorAt(sink, rawTimestampUs, context);
		cache.set(rawTimestampUs, descriptor);
		return descriptor;
	};

	const scoreShift = async (
		offsetAdjustmentUs: number,
	): Promise<ScoredVisualShift> => {
		const comparisons: VisualSequenceComparison[] = [];
		for (const referenceTimesUs of referenceTimesByWindow) {
			const referenceSequence: VisualFrameDescriptor[] = [];
			const followerSequence: VisualFrameDescriptor[] = [];
			for (const referenceTimeUs of referenceTimesUs) {
				const referenceRawTimestampUs =
					reference.descriptor.playbackOrigin.rawTimestampAtMediaTimeZeroUs +
					referenceTimeUs;
				const followerTimeUs =
					referenceTimeUs - candidate.offsetUs - offsetAdjustmentUs;
				const followerRawTimestampUs =
					follower.descriptor.playbackOrigin.rawTimestampAtMediaTimeZeroUs +
					followerTimeUs;
				const referenceDescriptor = await loadDescriptor(
					referenceCache,
					referenceSink,
					referenceRawTimestampUs,
				);
				const followerDescriptor = await loadDescriptor(
					followerCache,
					followerSink,
					followerRawTimestampUs,
				);
				if (referenceDescriptor && followerDescriptor) {
					referenceSequence.push(referenceDescriptor);
					followerSequence.push(followerDescriptor);
				}
			}
			comparisons.push(
				compareVisualSequences(referenceSequence, followerSequence),
			);
		}
		return {
			offsetAdjustmentUs,
			aggregate: aggregateVisualWindows(comparisons),
			comparisons,
			referenceTimesByWindow,
		};
	};

	const evaluated: ScoredVisualShift[] = [];
	for (const adjustmentUs of DEFAULT_VISUAL_SEQUENCE_CONFIG.coarseOffsetAdjustmentsUs) {
		evaluated.push(await scoreShift(adjustmentUs));
		progress(
			"refine",
			framesRequested,
			MAXIMUM_VISUAL_FRAMES_PER_CANDIDATE,
			follower.descriptor.fileIndex,
			`Comparing ordered visual sequences for candidate #${candidate.rank}`,
		);
	}
	const bySimilarity = (left: ScoredVisualShift, right: ScoredVisualShift) =>
		(right.aggregate.similarity ?? Number.NEGATIVE_INFINITY) -
		(left.aggregate.similarity ?? Number.NEGATIVE_INFINITY);
	const coarseBest = [...evaluated].sort(bySimilarity)[0];
	if (coarseBest && coarseBest.aggregate.similarity !== null) {
		for (const direction of [-1, 1]) {
			evaluated.push(
				await scoreShift(
					coarseBest.offsetAdjustmentUs +
						direction * DEFAULT_VISUAL_SEQUENCE_CONFIG.fineOffsetRadiusUs,
				),
			);
		}
	}
	const selected = [...evaluated].sort(bySimilarity)[0];
	if (!selected || selected.aggregate.similarity === null) {
		const fallback = visualEvidence(
			candidate,
			"ambiguous",
			coarseBest?.aggregate.reason ??
				"Ordered frame sequences were unavailable; manual timing remains required.",
		);
		fallback.framesRequested = framesRequested;
		return fallback;
	}

	const windows = selected.comparisons.map((comparison, index) => ({
		anchorReferenceTimeUs: anchors[index] ?? 0,
		sampleReferenceTimesUs: selected.referenceTimesByWindow[index] ?? [],
		selectedOffsetAdjustmentUs: selected.offsetAdjustmentUs,
		status: comparison.status,
		similarity: comparison.similarity,
		spatialSimilarity: comparison.spatialSimilarity,
		transitionSimilarity: comparison.transitionSimilarity,
		framesRequested: (selected.referenceTimesByWindow[index]?.length ?? 0) * 2,
		framesCompared: comparison.framesCompared,
		activeTileCount: comparison.activeTileCount,
		rejectedTileIndexes: comparison.rejectedTileIndexes,
	}));
	const status = selected.aggregate.status;
	return {
		status,
		descriptor: "tiled-luma-color-gradient-v1",
		sequence: "ordered-banded-v1",
		similarity: selected.aggregate.similarity,
		spatialSimilarity: selected.aggregate.spatialSimilarity,
		transitionSimilarity: selected.aggregate.transitionSimilarity,
		audioOffsetUs: candidate.offsetUs,
		refinedOffsetUs:
			status === "scored"
				? candidate.offsetUs + selected.offsetAdjustmentUs
				: null,
		selectedOffsetAdjustmentUs: selected.offsetAdjustmentUs,
		framesRequested,
		framesCompared: windows.reduce(
			(total, window) => total + window.framesCompared,
			0,
		),
		sampleReferenceTimesUs: windows.flatMap(
			({ sampleReferenceTimesUs }) => sampleReferenceTimesUs,
		),
		windows,
		bounds: {
			maximumCandidates: DEFAULT_VISUAL_SEQUENCE_CONFIG.maximumCandidates,
			maximumFramesPerCandidate: MAXIMUM_VISUAL_FRAMES_PER_CANDIDATE,
			maximumConcurrentDecodes: 1,
		},
		evidence: `${selected.aggregate.reason} Compared bounded tiled luma/color/gradient transitions without OCR, models, uploads, or retained frames.`,
	};
}

async function refineWithVisualEvidence(
	reference: OpenFile,
	follower: OpenFile,
	alignment: AudioSyncAlignment,
): Promise<AudioSyncAlignment> {
	if (alignment.candidates.length === 0) return alignment;
	if (
		!reference.videoTrack ||
		!follower.videoTrack ||
		typeof OffscreenCanvas === "undefined"
	) {
		return {
			...alignment,
			candidates: alignment.candidates.map((candidate) => ({
				...candidate,
				visual: visualEvidence(
					candidate,
					"unavailable",
					"No decodable video-track pair was available for local ordered-sequence comparison.",
				),
			})),
		};
	}

	const { descriptorWidth, descriptorHeight } = DEFAULT_VISUAL_SEQUENCE_CONFIG;
	const canvas = new OffscreenCanvas(descriptorWidth, descriptorHeight);
	const context = canvas.getContext("2d", { willReadFrequently: true });
	if (!context) return alignment;
	const referenceSink = new VideoSampleSink(reference.videoTrack);
	const followerSink = new VideoSampleSink(follower.videoTrack);
	const candidates: SyncCandidate[] = [];
	for (const [candidateIndex, candidate] of alignment.candidates.entries()) {
		if (candidateIndex >= DEFAULT_VISUAL_SEQUENCE_CONFIG.maximumCandidates) {
			candidates.push({
				...candidate,
				visual: visualEvidence(
					candidate,
					"skipped",
					`Visual refinement is bounded to the top ${DEFAULT_VISUAL_SEQUENCE_CONFIG.maximumCandidates} audio candidates.`,
				),
			});
			continue;
		}
		try {
			candidates.push({
				...candidate,
				visual: await scoreVisualCandidate(
					reference,
					follower,
					candidate,
					referenceSink,
					followerSink,
					context,
				),
			});
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError")
				throw error;
			candidates.push({
				...candidate,
				visual: visualEvidence(
					candidate,
					"unavailable",
					`Local ordered visual decoding was unavailable: ${error instanceof Error ? error.message : String(error)}`,
				),
			});
		}
	}

	const scored = candidates.filter(
		(candidate) => candidate.visual?.status === "scored",
	);
	const visualBest = selectVisualTiebreakCandidate(candidates);
	const reorder = visualBest !== null;
	const ranked = reorder
		? [
				visualBest,
				...candidates.filter((candidate) => candidate !== visualBest),
			]
		: candidates;
	const leadingAdjustmentUs =
		ranked[0]?.visual?.selectedOffsetAdjustmentUs ?? 0;
	return {
		...alignment,
		candidates: ranked.map((candidate, index) => ({
			...candidate,
			rank: index + 1,
		})),
		confidence:
			reorder || leadingAdjustmentUs !== 0 ? "ambiguous" : alignment.confidence,
		confidenceReasons: [
			...alignment.confidenceReasons,
			reorder
				? "Ordered visual sequences changed the leading candidate; manual review remains required."
				: leadingAdjustmentUs !== 0
					? "Ordered visual sequences refined the leading offset; manual review remains required."
					: scored.length > 0
						? "Ordered visual sequences supported the audio ranking without raising confidence."
						: "Ordered visual evidence was weak, repetitive, contradictory, or unavailable; audio ranking is unchanged.",
		],
	};
}

function finalizeFile(file: OpenFile) {
	const reads = file.ranges.summary();
	file.descriptor.reads = {
		...reads,
		percentOfFile:
			file.file.size === 0 ? 0 : (reads.uniqueBytes / file.file.size) * 100,
	};
}

function disposeFile(file: OpenFile) {
	if (file.descriptor.inputDisposed) return;
	file.input.dispose();
	file.descriptor.inputDisposed = true;
	active?.inputs.delete(file.input);
}

async function run(
	request: Extract<AudioSyncWorkerRequest, { type: "align" }>,
) {
	if (active) {
		send({
			id: request.id,
			type: "error",
			message: "Another audio alignment is already running",
		});
		return;
	}

	const started = performance.now();
	active = {
		id: request.id,
		cancelled: false,
		inputs: new Set(),
		queueHighWater: 1,
		audioSamplesClosed: 0,
		videoSamplesClosed: 0,
	};
	const files: OpenFile[] = [];
	try {
		for (const [index, file] of request.files.entries()) {
			progress(
				"inspect",
				index,
				request.files.length,
				index,
				`Inspecting ${file.name}`,
			);
			files.push(await openFile(file, index));
		}

		const totalTracks = files.reduce(
			(total, file) => total + file.audioTracks.length,
			0,
		);
		const extractedByFile: ExtractedTrack[][] = files.map(() => []);
		let completedTracks = 0;
		for (const file of files) {
			const extracted = extractedByFile[file.descriptor.fileIndex];
			if (!extracted) throw new Error("Internal file index mismatch");
			for (const track of file.audioTracks) {
				const result = await extractTrack(
					file,
					track,
					completedTracks,
					totalTracks,
				);
				extracted.push(result);
				file.descriptor.tracks.push(result.descriptor);
				completedTracks += 1;
			}
		}

		const referenceIndex = request.referenceIndex;
		const referenceFile = files[referenceIndex];
		const referenceTracks = extractedByFile[referenceIndex];
		if (!referenceFile || !referenceTracks)
			throw new Error("Synchronization reference is required");
		const pairsByFollower = files.map((followerFile, followerIndex) => {
			if (followerIndex === referenceIndex) return [];
			const pairs: AudioFeaturePair[] = [];
			for (const reference of referenceTracks) {
				for (const follower of extractedByFile[followerIndex] ?? []) {
					pairs.push({
						reference: reference.feature,
						follower: follower.feature,
						referenceOrigin: referenceFile.descriptor.playbackOrigin,
						followerOrigin: followerFile.descriptor.playbackOrigin,
					});
				}
			}
			return pairs;
		});
		const totalPairs = pairsByFollower.reduce(
			(total, pairs) => total + pairs.length,
			0,
		);
		let completedPairs = 0;
		const alignments: AudioSyncAlignment[] = [];
		for (const [followerIndex, pairs] of pairsByFollower.entries()) {
			if (followerIndex === referenceIndex) continue;
			progress(
				"search",
				completedPairs,
				Math.max(1, totalPairs),
				followerIndex,
				pairs.length === 0
					? `POV ${followerIndex + 1} has no decodable audio pair`
					: `Searching ${pairs.length} track-pair lag ranges for POV ${followerIndex + 1}`,
			);
			const followerFile = files[followerIndex];
			if (!followerFile)
				throw new Error("Internal follower file index mismatch");
			const alignment = await refineWithVisualEvidence(
				referenceFile,
				followerFile,
				{
					followerIndex,
					...alignAudioFeatures(pairs),
				},
			);
			completedPairs += pairs.length;
			progress(
				"refine",
				completedPairs,
				Math.max(1, totalPairs),
				followerIndex,
				`Ranked audio candidates and compared bounded ordered visual sequences for POV ${followerIndex + 1}`,
			);
			alignments.push(alignment);
		}

		for (const file of files) {
			finalizeFile(file);
			disposeFile(file);
		}
		const state = assertActive();
		const result: AudioSyncResult = {
			schemaVersion: 3,
			algorithm: {
				version: "energy-onset-fft-v1+ordered-visual-v1",
				fineFeatureBinUs: DEFAULT_AUDIO_SYNC_CONFIG.fineFeatureBinUs,
				coarseFeatureBinUs: DEFAULT_AUDIO_SYNC_CONFIG.coarseFeatureBinUs,
				refinementRadiusUs: DEFAULT_AUDIO_SYNC_CONFIG.refinementRadiusUs,
				maximumCandidates: DEFAULT_AUDIO_SYNC_CONFIG.maximumCandidates,
				minimumRankedOverlapUs:
					DEFAULT_AUDIO_SYNC_CONFIG.minimumRankedOverlapUs,
				provisionalThresholds: { ...DEFAULT_AUDIO_SYNC_CONFIG.thresholds },
				visual: {
					descriptor: "tiled-luma-color-gradient-v1",
					sequence: "ordered-banded-v1",
					maximumCandidates: DEFAULT_VISUAL_SEQUENCE_CONFIG.maximumCandidates,
					windowCount: DEFAULT_VISUAL_SEQUENCE_CONFIG.windowCount,
					framesPerWindow: DEFAULT_VISUAL_SEQUENCE_CONFIG.framesPerWindow,
					sampleIntervalUs: DEFAULT_VISUAL_SEQUENCE_CONFIG.sampleIntervalUs,
					coarseOffsetAdjustmentsUs:
						DEFAULT_VISUAL_SEQUENCE_CONFIG.coarseOffsetAdjustmentsUs,
					fineOffsetRadiusUs: DEFAULT_VISUAL_SEQUENCE_CONFIG.fineOffsetRadiusUs,
					maximumFramesPerCandidate: MAXIMUM_VISUAL_FRAMES_PER_CANDIDATE,
					maximumConcurrentDecodes: 1,
				},
			},
			referenceIndex,
			files: files.map(({ descriptor }) => descriptor),
			alignments,
			elapsedMilliseconds: performance.now() - started,
			queueHighWater: state.queueHighWater,
			cleanup: {
				inputsDisposed: files.every(
					({ descriptor }) => descriptor.inputDisposed,
				),
				audioSamplesClosed: state.audioSamplesClosed,
				videoSamplesClosed: state.videoSamplesClosed,
			},
		};
		send({ id: request.id, type: "result", result });
	} catch (error) {
		if (active && !active.cancelled) {
			send({
				id: request.id,
				type: "error",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	} finally {
		for (const file of files) disposeFile(file);
		for (const input of active?.inputs ?? []) input.dispose();
		active = undefined;
	}
}

addEventListener("message", (event: MessageEvent<AudioSyncWorkerRequest>) => {
	if (event.data.type === "align") {
		void run(event.data);
		return;
	}
	if (!active || event.data.id !== active.id) return;
	active.cancelled = true;
	for (const input of active.inputs) input.dispose();
	send({
		id: event.data.id,
		type: "cancelled",
		queueHighWater: active.queueHighWater,
		audioSamplesClosed: active.audioSamplesClosed,
		videoSamplesClosed: active.videoSamplesClosed,
	});
});
