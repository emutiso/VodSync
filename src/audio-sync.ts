import type { SyncCandidate, SyncConfidence } from "./sync-types";
import { type PlaybackOrigin, rawLagToPlaybackOffsetUs } from "./timeline";
import { DEFAULT_VISUAL_SEQUENCE_CONFIG } from "./visual-sequence";

export const DEFAULT_AUDIO_SYNC_CONFIG = {
	fineFeatureBinUs: 50_000,
	coarseFeatureBinUs: 500_000,
	refinementRadiusUs: 1_000_000,
	maximumCandidates: 5,
	minimumRankedOverlapUs: 5_000_000,
	thresholds: {
		score: 0.42,
		weightedScore: 0.32,
		peakSeparation: 0.05,
		windowConsistency: 2 / 3,
		activeFeatureCount: 12,
	},
} as const;

export type AudioFeatureSeries = {
	trackId: number;
	values: Float32Array;
	startTimestampUs: number;
	binUs: number;
	activeFeatureCount: number;
};

export type AudioFeaturePair = {
	reference: AudioFeatureSeries;
	follower: AudioFeatureSeries;
	referenceOrigin: PlaybackOrigin;
	followerOrigin: PlaybackOrigin;
};

export type FeatureAlignment = {
	searchedTrackPairs: number;
	searchedRawLagRangeUs: { minimum: number; maximum: number };
	candidates: SyncCandidate[];
	confidence: SyncConfidence;
	confidenceReasons: string[];
};

export function candidatePlaybackOffsetUs(candidate: SyncCandidate) {
	return candidate.visual?.status === "scored" &&
		candidate.visual.refinedOffsetUs !== null
		? candidate.visual.refinedOffsetUs
		: candidate.offsetUs;
}

export function selectVisualTiebreakCandidate(
	candidates: readonly SyncCandidate[],
): SyncCandidate | null {
	const audioTop = candidates[0];
	const audioTopSimilarity =
		audioTop?.visual?.status === "scored" ? audioTop.visual.similarity : null;
	if (!audioTop || audioTopSimilarity === null) return null;

	const visualBest = candidates
		.filter(
			(candidate) =>
				candidate.visual?.status === "scored" &&
				candidate.visual.similarity !== null,
		)
		.sort(
			(first, second) =>
				(second.visual?.similarity ?? Number.NEGATIVE_INFINITY) -
				(first.visual?.similarity ?? Number.NEGATIVE_INFINITY),
		)[0];
	if (!visualBest || visualBest === audioTop) return null;

	const visualDelta =
		(visualBest.visual?.similarity ?? audioTopSimilarity) - audioTopSimilarity;
	const audioAdvantage = audioTop.weightedScore - visualBest.weightedScore;
	return visualDelta >= DEFAULT_VISUAL_SEQUENCE_CONFIG.visualLeadRequired &&
		audioAdvantage <= DEFAULT_VISUAL_SEQUENCE_CONFIG.maximumAudioTrail
		? visualBest
		: null;
}

type ScoredLag = {
	lag: number;
	score: number;
	weightedScore: number;
	overlap: number;
};

function nextPowerOfTwo(value: number) {
	let result = 1;
	while (result < value) result *= 2;
	return result;
}

function fft(real: Float64Array, imaginary: Float64Array, inverse: boolean) {
	const length = real.length;
	for (let index = 1, reversed = 0; index < length; index += 1) {
		let bit = length >> 1;
		for (; reversed & bit; bit >>= 1) reversed ^= bit;
		reversed ^= bit;
		if (index >= reversed) continue;
		[real[index], real[reversed]] = [real[reversed] ?? 0, real[index] ?? 0];
		[imaginary[index], imaginary[reversed]] = [
			imaginary[reversed] ?? 0,
			imaginary[index] ?? 0,
		];
	}

	for (let size = 2; size <= length; size *= 2) {
		const angle = ((inverse ? 2 : -2) * Math.PI) / size;
		const stepReal = Math.cos(angle);
		const stepImaginary = Math.sin(angle);
		for (let start = 0; start < length; start += size) {
			let phaseReal = 1;
			let phaseImaginary = 0;
			for (let offset = 0; offset < size / 2; offset += 1) {
				const even = start + offset;
				const odd = even + size / 2;
				const oddReal =
					(real[odd] ?? 0) * phaseReal - (imaginary[odd] ?? 0) * phaseImaginary;
				const oddImaginary =
					(real[odd] ?? 0) * phaseImaginary + (imaginary[odd] ?? 0) * phaseReal;
				const evenReal = real[even] ?? 0;
				const evenImaginary = imaginary[even] ?? 0;
				real[even] = evenReal + oddReal;
				imaginary[even] = evenImaginary + oddImaginary;
				real[odd] = evenReal - oddReal;
				imaginary[odd] = evenImaginary - oddImaginary;
				const nextPhaseReal =
					phaseReal * stepReal - phaseImaginary * stepImaginary;
				phaseImaginary = phaseReal * stepImaginary + phaseImaginary * stepReal;
				phaseReal = nextPhaseReal;
			}
		}
	}

	if (!inverse) return;
	for (let index = 0; index < length; index += 1) {
		real[index] = (real[index] ?? 0) / length;
		imaginary[index] = (imaginary[index] ?? 0) / length;
	}
}

function normalized(values: Float32Array) {
	const output = new Float64Array(values.length);
	if (values.length === 0) return output;
	let sum = 0;
	for (const value of values) sum += value;
	const mean = sum / values.length;
	let squareSum = 0;
	for (const value of values) squareSum += (value - mean) ** 2;
	const deviation = Math.sqrt(squareSum / values.length);
	if (deviation < 1e-9) return output;
	for (let index = 0; index < values.length; index += 1) {
		output[index] = ((values[index] ?? 0) - mean) / deviation;
	}
	return output;
}

function downsample(values: Float32Array, factor: number) {
	const result = new Float32Array(Math.ceil(values.length / factor));
	for (let outputIndex = 0; outputIndex < result.length; outputIndex += 1) {
		const start = outputIndex * factor;
		const end = Math.min(values.length, start + factor);
		let maximum = 0;
		for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
			maximum = Math.max(maximum, values[inputIndex] ?? 0);
		}
		result[outputIndex] = maximum;
	}
	return result;
}

function squaredPrefix(values: Float64Array) {
	const prefix = new Float64Array(values.length + 1);
	for (let index = 0; index < values.length; index += 1) {
		prefix[index + 1] = (prefix[index] ?? 0) + (values[index] ?? 0) ** 2;
	}
	return prefix;
}

function energy(prefix: Float64Array, start: number, end: number) {
	return Math.max(0, (prefix[end] ?? 0) - (prefix[start] ?? 0));
}

function scoreAllLags(reference: Float64Array, follower: Float64Array) {
	const convolutionLength = reference.length + follower.length - 1;
	if (convolutionLength <= 0) return [];
	const fftLength = nextPowerOfTwo(convolutionLength);
	const referenceReal = new Float64Array(fftLength);
	const referenceImaginary = new Float64Array(fftLength);
	const followerReal = new Float64Array(fftLength);
	const followerImaginary = new Float64Array(fftLength);
	referenceReal.set(reference);
	for (let index = 0; index < follower.length; index += 1) {
		followerReal[index] = follower[follower.length - 1 - index] ?? 0;
	}
	fft(referenceReal, referenceImaginary, false);
	fft(followerReal, followerImaginary, false);
	for (let index = 0; index < fftLength; index += 1) {
		const firstReal = referenceReal[index] ?? 0;
		const firstImaginary = referenceImaginary[index] ?? 0;
		const secondReal = followerReal[index] ?? 0;
		const secondImaginary = followerImaginary[index] ?? 0;
		referenceReal[index] =
			firstReal * secondReal - firstImaginary * secondImaginary;
		referenceImaginary[index] =
			firstReal * secondImaginary + firstImaginary * secondReal;
	}
	fft(referenceReal, referenceImaginary, true);

	const referenceEnergy = squaredPrefix(reference);
	const followerEnergy = squaredPrefix(follower);
	const scores: ScoredLag[] = [];
	const minimumLength = Math.min(reference.length, follower.length);
	for (
		let lag = -(follower.length - 1);
		lag <= reference.length - 1;
		lag += 1
	) {
		const followerStart = Math.max(0, -lag);
		const followerEnd = Math.min(follower.length, reference.length - lag);
		const referenceStart = followerStart + lag;
		const referenceEnd = followerEnd + lag;
		const overlap = followerEnd - followerStart;
		const denominator = Math.sqrt(
			energy(referenceEnergy, referenceStart, referenceEnd) *
				energy(followerEnergy, followerStart, followerEnd),
		);
		const dot = referenceReal[lag + follower.length - 1] ?? 0;
		const score =
			denominator <= 1e-9 ? 0 : Math.max(-1, Math.min(1, dot / denominator));
		scores.push({
			lag,
			score,
			weightedScore: Math.max(0, score) * Math.sqrt(overlap / minimumLength),
			overlap,
		});
	}
	return scores;
}

function directScore(
	reference: Float64Array,
	follower: Float64Array,
	lag: number,
	requestedStart = 0,
	requestedEnd = Number.POSITIVE_INFINITY,
): ScoredLag {
	const followerStart = Math.max(0, -lag, requestedStart);
	const followerEnd = Math.min(
		follower.length,
		reference.length - lag,
		requestedEnd,
	);
	const overlap = Math.max(0, followerEnd - followerStart);
	let dot = 0;
	let referenceSquares = 0;
	let followerSquares = 0;
	for (
		let followerIndex = followerStart;
		followerIndex < followerEnd;
		followerIndex += 1
	) {
		const referenceValue = reference[followerIndex + lag] ?? 0;
		const followerValue = follower[followerIndex] ?? 0;
		dot += referenceValue * followerValue;
		referenceSquares += referenceValue * referenceValue;
		followerSquares += followerValue * followerValue;
	}
	const denominator = Math.sqrt(referenceSquares * followerSquares);
	const score =
		denominator <= 1e-9 ? 0 : Math.max(-1, Math.min(1, dot / denominator));
	return {
		lag,
		score,
		weightedScore:
			Math.max(0, score) *
			Math.sqrt(overlap / Math.min(reference.length, follower.length)),
		overlap,
	};
}

function peakLags(
	scores: readonly ScoredLag[],
	minimumOverlap: number,
	maximum: number,
) {
	const localPeaks = scores.filter((candidate, index) => {
		if (candidate.overlap < minimumOverlap || candidate.weightedScore <= 0)
			return false;
		const previous =
			scores[index - 1]?.weightedScore ?? Number.NEGATIVE_INFINITY;
		const next = scores[index + 1]?.weightedScore ?? Number.NEGATIVE_INFINITY;
		return (
			candidate.weightedScore >= previous && candidate.weightedScore >= next
		);
	});
	localPeaks.sort(
		(first, second) => second.weightedScore - first.weightedScore,
	);
	const selected: ScoredLag[] = [];
	for (const candidate of localPeaks) {
		if (selected.some(({ lag }) => Math.abs(lag - candidate.lag) < 4)) continue;
		selected.push(candidate);
		if (selected.length >= maximum) break;
	}
	return selected;
}

function windowScores(
	reference: Float64Array,
	follower: Float64Array,
	lag: number,
) {
	const followerStart = Math.max(0, -lag);
	const followerEnd = Math.min(follower.length, reference.length - lag);
	const overlap = followerEnd - followerStart;
	if (overlap <= 0) return [];
	const windowLength = Math.max(1, Math.min(1_200, Math.floor(overlap / 3)));
	const available = Math.max(0, overlap - windowLength);
	return [0.1, 0.5, 0.9].map((position) => {
		const start = followerStart + Math.round(available * position);
		return directScore(reference, follower, lag, start, start + windowLength)
			.score;
	});
}

function alignPair(pair: AudioFeaturePair) {
	const factor =
		DEFAULT_AUDIO_SYNC_CONFIG.coarseFeatureBinUs / pair.reference.binUs;
	if (
		!Number.isInteger(factor) ||
		pair.reference.binUs !== pair.follower.binUs
	) {
		throw new Error(
			"Audio feature bins must share the configured fine resolution",
		);
	}
	const coarseReference = normalized(downsample(pair.reference.values, factor));
	const coarseFollower = normalized(downsample(pair.follower.values, factor));
	const allCoarseScores = scoreAllLags(coarseReference, coarseFollower);
	const minimumCoarseOverlap = Math.ceil(
		DEFAULT_AUDIO_SYNC_CONFIG.minimumRankedOverlapUs /
			DEFAULT_AUDIO_SYNC_CONFIG.coarseFeatureBinUs,
	);
	const coarsePeaks = peakLags(
		allCoarseScores,
		minimumCoarseOverlap,
		DEFAULT_AUDIO_SYNC_CONFIG.maximumCandidates * 2,
	);
	const fineReference = normalized(pair.reference.values);
	const fineFollower = normalized(pair.follower.values);
	const refinementBins = Math.round(
		DEFAULT_AUDIO_SYNC_CONFIG.refinementRadiusUs / pair.reference.binUs,
	);
	const refined: Omit<SyncCandidate, "rank" | "peakSeparation">[] = [];

	for (const coarsePeak of coarsePeaks) {
		const coarseRawLagUs =
			pair.reference.startTimestampUs -
			pair.follower.startTimestampUs +
			coarsePeak.lag * DEFAULT_AUDIO_SYNC_CONFIG.coarseFeatureBinUs;
		const approximateFineLag = Math.round(
			(coarseRawLagUs -
				pair.reference.startTimestampUs +
				pair.follower.startTimestampUs) /
				pair.reference.binUs,
		);
		let best = directScore(fineReference, fineFollower, approximateFineLag);
		for (
			let lag = approximateFineLag - refinementBins;
			lag <= approximateFineLag + refinementBins;
			lag += 1
		) {
			const candidate = directScore(fineReference, fineFollower, lag);
			if (candidate.weightedScore > best.weightedScore) best = candidate;
		}
		const rawLagUs =
			pair.reference.startTimestampUs -
			pair.follower.startTimestampUs +
			best.lag * pair.reference.binUs;
		const windows = windowScores(fineReference, fineFollower, best.lag);
		const consistency =
			windows.length === 0
				? 0
				: windows.filter((score) => score >= Math.max(0.12, best.score * 0.4))
						.length / windows.length;
		refined.push({
			referenceTrackId: pair.reference.trackId,
			followerTrackId: pair.follower.trackId,
			rawLagUs,
			offsetUs: rawLagToPlaybackOffsetUs(
				rawLagUs,
				pair.referenceOrigin,
				pair.followerOrigin,
			),
			score: best.score,
			weightedScore: best.weightedScore * (0.5 + 0.5 * consistency),
			overlapUs: best.overlap * pair.reference.binUs,
			overlapFeatureCount: best.overlap,
			windowScores: windows,
			windowConsistency: consistency,
		});
	}

	const minimumRawLagUs =
		pair.reference.startTimestampUs -
		pair.follower.startTimestampUs -
		Math.max(0, coarseFollower.length - 1) *
			DEFAULT_AUDIO_SYNC_CONFIG.coarseFeatureBinUs;
	const maximumRawLagUs =
		pair.reference.startTimestampUs -
		pair.follower.startTimestampUs +
		Math.max(0, coarseReference.length - 1) *
			DEFAULT_AUDIO_SYNC_CONFIG.coarseFeatureBinUs;
	return { refined, minimumRawLagUs, maximumRawLagUs };
}

export function classifySyncConfidence(
	candidates: readonly SyncCandidate[],
	activeFeatureCount: number,
) {
	const top = candidates[0];
	const confidenceReasons: string[] = [];
	let confidence: SyncConfidence = "provisional";
	if (
		!top ||
		activeFeatureCount < DEFAULT_AUDIO_SYNC_CONFIG.thresholds.activeFeatureCount
	) {
		confidence = "no-signal";
		confidenceReasons.push(
			"Too little non-silent feature activity was available.",
		);
	} else {
		const belowAbsoluteThreshold =
			top.score < DEFAULT_AUDIO_SYNC_CONFIG.thresholds.score ||
			top.weightedScore < DEFAULT_AUDIO_SYNC_CONFIG.thresholds.weightedScore;
		const dominantLowCorrelation =
			candidates.length > 1 &&
			top.score >= 0.12 &&
			top.weightedScore >= 0.1 &&
			top.peakSeparation >= 0.1 &&
			top.peakSeparation / top.score >= 0.6 &&
			top.windowConsistency >=
				DEFAULT_AUDIO_SYNC_CONFIG.thresholds.windowConsistency;

		if (belowAbsoluteThreshold) {
			if (dominantLowCorrelation) {
				confidence = "dominant";
				confidenceReasons.push(
					"One candidate is clearly dominant, but its absolute audio correlation remains too low to treat as verified.",
				);
			} else {
				confidence = "weak";
				if (top.score < DEFAULT_AUDIO_SYNC_CONFIG.thresholds.score)
					confidenceReasons.push(
						"The strongest normalized correlation score is below threshold.",
					);
				if (
					top.weightedScore < DEFAULT_AUDIO_SYNC_CONFIG.thresholds.weightedScore
				)
					confidenceReasons.push(
						"The strongest overlap-weighted score is below threshold.",
					);
			}
		}
		if (
			top.windowConsistency <
			DEFAULT_AUDIO_SYNC_CONFIG.thresholds.windowConsistency
		) {
			confidence = "weak";
			confidenceReasons.push(
				"The candidate is not consistent across beginning, middle, and end windows.",
			);
		}
		if (
			top.peakSeparation < DEFAULT_AUDIO_SYNC_CONFIG.thresholds.peakSeparation
		) {
			confidence = confidence === "weak" ? "weak" : "ambiguous";
			confidenceReasons.push(
				"Competing offset peaks are too close to distinguish safely.",
			);
		}
	}
	if (confidence === "provisional") {
		confidenceReasons.push(
			"The strongest candidate clears provisional audio-only thresholds.",
		);
	}
	return { confidence, confidenceReasons };
}

export function alignAudioFeatures(
	pairs: readonly AudioFeaturePair[],
): FeatureAlignment {
	if (pairs.length === 0) {
		return {
			searchedTrackPairs: 0,
			searchedRawLagRangeUs: { minimum: 0, maximum: 0 },
			candidates: [],
			confidence: "no-signal",
			confidenceReasons: ["No decodable audio-track pair was available."],
		};
	}

	const results = pairs.map(alignPair);
	const ranked = results
		.flatMap(({ refined }) => refined)
		.sort((first, second) => second.weightedScore - first.weightedScore);
	const distinct: typeof ranked = [];
	for (const candidate of ranked) {
		if (
			distinct.some(
				(existing) =>
					Math.abs(existing.offsetUs - candidate.offsetUs) <
					DEFAULT_AUDIO_SYNC_CONFIG.fineFeatureBinUs * 2,
			)
		)
			continue;
		distinct.push(candidate);
		if (distinct.length >= DEFAULT_AUDIO_SYNC_CONFIG.maximumCandidates) break;
	}

	const candidates = distinct.map((candidate, index) => ({
		...candidate,
		rank: index + 1,
		peakSeparation: Math.max(
			0,
			candidate.score - (distinct[index + 1]?.score ?? 0),
		),
	}));
	const top = candidates[0];
	const topPair = top
		? pairs.find(
				({ reference, follower }) =>
					reference.trackId === top.referenceTrackId &&
					follower.trackId === top.followerTrackId,
			)
		: undefined;
	const activeFeatureCount = topPair
		? Math.min(
				topPair.reference.activeFeatureCount,
				topPair.follower.activeFeatureCount,
			)
		: 0;
	const { confidence, confidenceReasons } = classifySyncConfidence(
		candidates,
		activeFeatureCount,
	);

	return {
		searchedTrackPairs: pairs.length,
		searchedRawLagRangeUs: {
			minimum: Math.min(
				...results.map(({ minimumRawLagUs }) => minimumRawLagUs),
			),
			maximum: Math.max(
				...results.map(({ maximumRawLagUs }) => maximumRawLagUs),
			),
		},
		candidates,
		confidence,
		confidenceReasons,
	};
}
