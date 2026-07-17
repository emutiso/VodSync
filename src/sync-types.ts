import type { ByteRange } from "./ranges";
import type { PlaybackOrigin } from "./timeline";

export type SyncConfidence =
	| "provisional"
	| "dominant"
	| "ambiguous"
	| "weak"
	| "no-signal";

export type SyncTrackDescriptor = {
	fileIndex: number;
	id: number;
	number: number;
	codec: string | null;
	codecParameter: string | null;
	language: string;
	name: string | null;
	channels: number;
	sampleRateHz: number;
	rawFirstTimestampUs: number;
	durationUs: number;
	featureBinUs: number;
	featureCount: number;
	activeFeatureCount: number;
	samplesClosed: number;
};

export type SyncFileDescriptor = {
	fileIndex: number;
	name: string;
	sizeBytes: number;
	declaredMimeType: string;
	format: string;
	formatMimeType: string;
	durationUs: number;
	playbackOrigin: PlaybackOrigin;
	tracks: SyncTrackDescriptor[];
	reads: {
		requests: number;
		requestedBytes: number;
		uniqueBytes: number;
		uniqueBytesExact: boolean;
		rangesTruncated: boolean;
		percentOfFile: number;
		ranges: ByteRange[];
	};
	inputDisposed: boolean;
};

export type VisualSequenceWindowEvidence = {
	anchorReferenceTimeUs: number;
	sampleReferenceTimesUs: number[];
	selectedOffsetAdjustmentUs: number;
	status: "scored" | "static" | "insufficient";
	similarity: number | null;
	spatialSimilarity: number | null;
	transitionSimilarity: number | null;
	framesRequested: number;
	framesCompared: number;
	activeTileCount: number;
	rejectedTileIndexes: number[];
};

export type VisualCandidateEvidence = {
	status: "scored" | "ambiguous" | "unavailable" | "skipped";
	descriptor: "tiled-luma-color-gradient-v1";
	sequence: "ordered-banded-v1";
	similarity: number | null;
	spatialSimilarity: number | null;
	transitionSimilarity: number | null;
	audioOffsetUs: number;
	refinedOffsetUs: number | null;
	selectedOffsetAdjustmentUs: number;
	framesRequested: number;
	framesCompared: number;
	sampleReferenceTimesUs: number[];
	windows: VisualSequenceWindowEvidence[];
	bounds: {
		maximumCandidates: number;
		maximumFramesPerCandidate: number;
		maximumConcurrentDecodes: number;
	};
	evidence: string;
};

export type SyncCandidate = {
	rank: number;
	referenceTrackId: number;
	followerTrackId: number;
	rawLagUs: number;
	offsetUs: number;
	score: number;
	weightedScore: number;
	overlapUs: number;
	overlapFeatureCount: number;
	peakSeparation: number;
	windowScores: number[];
	windowConsistency: number;
	visual?: VisualCandidateEvidence;
};

export type AudioSyncAlignment = {
	followerIndex: number;
	searchedTrackPairs: number;
	searchedRawLagRangeUs: { minimum: number; maximum: number };
	candidates: SyncCandidate[];
	confidence: SyncConfidence;
	confidenceReasons: string[];
};

export type AudioSyncResult = {
	schemaVersion: 3;
	algorithm: {
		version: "energy-onset-fft-v1+ordered-visual-v1";
		fineFeatureBinUs: number;
		coarseFeatureBinUs: number;
		refinementRadiusUs: number;
		maximumCandidates: number;
		minimumRankedOverlapUs: number;
		provisionalThresholds: {
			score: number;
			weightedScore: number;
			peakSeparation: number;
			windowConsistency: number;
			activeFeatureCount: number;
		};
		visual: {
			descriptor: "tiled-luma-color-gradient-v1";
			sequence: "ordered-banded-v1";
			maximumCandidates: number;
			windowCount: number;
			framesPerWindow: number;
			sampleIntervalUs: number;
			coarseOffsetAdjustmentsUs: readonly number[];
			fineOffsetRadiusUs: number;
			maximumFramesPerCandidate: number;
			maximumConcurrentDecodes: number;
		};
	};
	referenceIndex: number;
	files: SyncFileDescriptor[];
	alignments: AudioSyncAlignment[];
	elapsedMilliseconds: number;
	queueHighWater: number;
	cleanup: {
		inputsDisposed: boolean;
		audioSamplesClosed: number;
		videoSamplesClosed: number;
	};
};

export type AudioSyncWorkerRequest =
	| { id: string; type: "align"; files: File[]; referenceIndex: number }
	| { id: string; type: "cancel" };

export type AudioSyncProgress = {
	stage: "inspect" | "decode" | "search" | "refine";
	completed: number;
	total: number;
	fileIndex: number | null;
	detail: string;
};

export type AudioSyncWorkerResponse =
	| { id: string; type: "result"; result: AudioSyncResult }
	| {
			id: string;
			type: "cancelled";
			queueHighWater: number;
			audioSamplesClosed: number;
			videoSamplesClosed: number;
	  }
	| { id: string; type: "error"; message: string }
	| ({ id: string; type: "progress" } & AudioSyncProgress);
