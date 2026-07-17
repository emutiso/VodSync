export const DEFAULT_VISUAL_SEQUENCE_CONFIG = {
	descriptorWidth: 96,
	descriptorHeight: 54,
	tileColumns: 6,
	tileRows: 4,
	maximumCandidates: 3,
	windowCount: 3,
	framesPerWindow: 3,
	sampleIntervalUs: 400_000,
	coarseOffsetAdjustmentsUs: [-400_000, 0, 400_000],
	fineOffsetRadiusUs: 100_000,
	minimumComparableFrames: 3,
	minimumActiveTiles: 6,
	minimumScoredWindows: 2,
	minimumSequenceSimilarity: 0.72,
	maximumRejectedTiles: 6,
	visualLeadRequired: 0.15,
	maximumAudioTrail: 0.05,
} as const;

const FEATURES_PER_TILE = 7;
const LUMA_RED = 0.2126;
const LUMA_GREEN = 0.7152;
const LUMA_BLUE = 0.0722;

export type VisualFrameDescriptor = {
	timestampUs: number;
	tiles: Float32Array;
};

export type VisualSequenceComparison = {
	status: "scored" | "static" | "insufficient";
	similarity: number | null;
	spatialSimilarity: number | null;
	transitionSimilarity: number | null;
	framesCompared: number;
	activeTileCount: number;
	rejectedTileIndexes: number[];
};

export type VisualWindowAggregate = {
	status: "scored" | "ambiguous";
	similarity: number | null;
	spatialSimilarity: number | null;
	transitionSimilarity: number | null;
	scoredWindowCount: number;
	reason: string;
};

function clamp01(value: number) {
	return Math.min(1, Math.max(0, value));
}

function median(values: readonly number[]) {
	if (values.length === 0) return 0;
	const ordered = [...values].sort((left, right) => left - right);
	const middle = Math.floor(ordered.length / 2);
	const upper = ordered[middle] ?? 0;
	return ordered.length % 2 === 0
		? ((ordered[middle - 1] ?? upper) + upper) / 2
		: upper;
}

function featureOffset(tileIndex: number) {
	return tileIndex * FEATURES_PER_TILE;
}

function edgeIsDark(
	pixels: Uint8ClampedArray,
	width: number,
	horizontal: boolean,
	index: number,
	start: number,
	end: number,
) {
	let luminanceTotal = 0;
	let maximumLuminance = 0;
	for (let position = start; position < end; position += 1) {
		const x = horizontal ? position : index;
		const y = horizontal ? index : position;
		const offset = (y * width + x) * 4;
		const luminance =
			LUMA_RED * (pixels[offset] ?? 0) +
			LUMA_GREEN * (pixels[offset + 1] ?? 0) +
			LUMA_BLUE * (pixels[offset + 2] ?? 0);
		luminanceTotal += luminance;
		maximumLuminance = Math.max(maximumLuminance, luminance);
	}
	const length = Math.max(1, end - start);
	return luminanceTotal / length < 12 && maximumLuminance < 28;
}

function findContentBounds(
	pixels: Uint8ClampedArray,
	width: number,
	height: number,
) {
	let left = 0;
	let right = width;
	let top = 0;
	let bottom = height;
	const maximumHorizontalTrim = Math.floor(width * 0.18);
	const maximumVerticalTrim = Math.floor(height * 0.18);
	while (
		top < maximumVerticalTrim &&
		edgeIsDark(pixels, width, true, top, left, right)
	)
		top += 1;
	while (
		height - bottom < maximumVerticalTrim &&
		edgeIsDark(pixels, width, true, bottom - 1, left, right)
	)
		bottom -= 1;
	while (
		left < maximumHorizontalTrim &&
		edgeIsDark(pixels, width, false, left, top, bottom)
	)
		left += 1;
	while (
		width - right < maximumHorizontalTrim &&
		edgeIsDark(pixels, width, false, right - 1, top, bottom)
	)
		right -= 1;
	return { left, right, top, bottom };
}

export function describeVisualFrame(
	pixels: Uint8ClampedArray,
	width: number,
	height: number,
	timestampUs: number,
): VisualFrameDescriptor {
	if (
		!Number.isInteger(width) ||
		!Number.isInteger(height) ||
		width <= 0 ||
		height <= 0
	) {
		throw new Error("Visual descriptor dimensions must be positive integers");
	}
	if (pixels.length !== width * height * 4) {
		throw new Error(
			"Visual descriptor pixels do not match the supplied dimensions",
		);
	}

	const { tileColumns, tileRows } = DEFAULT_VISUAL_SEQUENCE_CONFIG;
	const { left, right, top, bottom } = findContentBounds(pixels, width, height);
	const contentWidth = Math.max(1, right - left);
	const contentHeight = Math.max(1, bottom - top);
	const tileCount = tileColumns * tileRows;
	const counts = new Uint32Array(tileCount);
	const lumaSums = new Float64Array(tileCount);
	const lumaSquaredSums = new Float64Array(tileCount);
	const redSums = new Float64Array(tileCount);
	const greenSums = new Float64Array(tileCount);
	const blueSums = new Float64Array(tileCount);
	const horizontalEdgeSums = new Float64Array(tileCount);
	const verticalEdgeSums = new Float64Array(tileCount);
	const horizontalEdgeCounts = new Uint32Array(tileCount);
	const verticalEdgeCounts = new Uint32Array(tileCount);

	const luminanceAt = (x: number, y: number) => {
		const offset = (y * width + x) * 4;
		return (
			LUMA_RED * (pixels[offset] ?? 0) +
			LUMA_GREEN * (pixels[offset + 1] ?? 0) +
			LUMA_BLUE * (pixels[offset + 2] ?? 0)
		);
	};

	for (let y = top; y < bottom; y += 1) {
		const tileY = Math.min(
			tileRows - 1,
			Math.floor(((y - top) * tileRows) / contentHeight),
		);
		for (let x = left; x < right; x += 1) {
			const tileX = Math.min(
				tileColumns - 1,
				Math.floor(((x - left) * tileColumns) / contentWidth),
			);
			const tileIndex = tileY * tileColumns + tileX;
			const pixelOffset = (y * width + x) * 4;
			const red = pixels[pixelOffset] ?? 0;
			const green = pixels[pixelOffset + 1] ?? 0;
			const blue = pixels[pixelOffset + 2] ?? 0;
			const luminance = LUMA_RED * red + LUMA_GREEN * green + LUMA_BLUE * blue;
			counts[tileIndex] = (counts[tileIndex] ?? 0) + 1;
			lumaSums[tileIndex] = (lumaSums[tileIndex] ?? 0) + luminance;
			lumaSquaredSums[tileIndex] =
				(lumaSquaredSums[tileIndex] ?? 0) + luminance * luminance;
			redSums[tileIndex] = (redSums[tileIndex] ?? 0) + red;
			greenSums[tileIndex] = (greenSums[tileIndex] ?? 0) + green;
			blueSums[tileIndex] = (blueSums[tileIndex] ?? 0) + blue;
			if (x > left) {
				horizontalEdgeSums[tileIndex] =
					(horizontalEdgeSums[tileIndex] ?? 0) +
					Math.abs(luminance - luminanceAt(x - 1, y));
				horizontalEdgeCounts[tileIndex] =
					(horizontalEdgeCounts[tileIndex] ?? 0) + 1;
			}
			if (y > top) {
				verticalEdgeSums[tileIndex] =
					(verticalEdgeSums[tileIndex] ?? 0) +
					Math.abs(luminance - luminanceAt(x, y - 1));
				verticalEdgeCounts[tileIndex] =
					(verticalEdgeCounts[tileIndex] ?? 0) + 1;
			}
		}
	}

	const tiles = new Float32Array(tileCount * FEATURES_PER_TILE);
	for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
		const count = Math.max(1, counts[tileIndex] ?? 0);
		const meanLuma = (lumaSums[tileIndex] ?? 0) / count;
		const variance = Math.max(
			0,
			(lumaSquaredSums[tileIndex] ?? 0) / count - meanLuma * meanLuma,
		);
		const meanRed = (redSums[tileIndex] ?? 0) / count;
		const meanGreen = (greenSums[tileIndex] ?? 0) / count;
		const meanBlue = (blueSums[tileIndex] ?? 0) / count;
		const offset = featureOffset(tileIndex);
		tiles[offset] = meanLuma / 255;
		tiles[offset + 1] = Math.sqrt(variance) / 128;
		tiles[offset + 2] = (meanRed - meanGreen) / 255;
		tiles[offset + 3] = (meanBlue - meanGreen) / 255;
		tiles[offset + 4] =
			(horizontalEdgeSums[tileIndex] ?? 0) /
			Math.max(1, horizontalEdgeCounts[tileIndex] ?? 0) /
			255;
		tiles[offset + 5] =
			(verticalEdgeSums[tileIndex] ?? 0) /
			Math.max(1, verticalEdgeCounts[tileIndex] ?? 0) /
			255;
		tiles[offset + 6] = (meanRed + meanGreen + meanBlue) / (3 * 255);
	}
	return { timestampUs, tiles };
}

function tileDistance(
	left: Float32Array,
	right: Float32Array,
	tileIndex: number,
) {
	const offset = featureOffset(tileIndex);
	const luminance = Math.abs((left[offset] ?? 0) - (right[offset] ?? 0));
	const contrast = Math.abs((left[offset + 1] ?? 0) - (right[offset + 1] ?? 0));
	const chroma =
		(Math.abs((left[offset + 2] ?? 0) - (right[offset + 2] ?? 0)) +
			Math.abs((left[offset + 3] ?? 0) - (right[offset + 3] ?? 0))) /
		2;
	const edges =
		(Math.abs((left[offset + 4] ?? 0) - (right[offset + 4] ?? 0)) +
			Math.abs((left[offset + 5] ?? 0) - (right[offset + 5] ?? 0))) /
		2;
	const brightness = Math.abs(
		(left[offset + 6] ?? 0) - (right[offset + 6] ?? 0),
	);
	return (
		0.12 * luminance +
		0.18 * contrast +
		0.12 * chroma +
		0.5 * edges +
		0.08 * brightness
	);
}

export function compareVisualSequences(
	reference: readonly VisualFrameDescriptor[],
	follower: readonly VisualFrameDescriptor[],
): VisualSequenceComparison {
	const framesCompared = Math.min(reference.length, follower.length);
	const {
		minimumComparableFrames,
		tileColumns,
		tileRows,
		maximumRejectedTiles,
	} = DEFAULT_VISUAL_SEQUENCE_CONFIG;
	if (framesCompared < minimumComparableFrames) {
		return {
			status: "insufficient",
			similarity: null,
			spatialSimilarity: null,
			transitionSimilarity: null,
			framesCompared,
			activeTileCount: 0,
			rejectedTileIndexes: [],
		};
	}

	const tileCount = tileColumns * tileRows;
	const spatialByTile = Array.from({ length: tileCount }, () => [] as number[]);
	const transitionByTile = Array.from(
		{ length: tileCount },
		() => [] as number[],
	);
	const activityByTile = Array.from(
		{ length: tileCount },
		() => [] as number[],
	);

	for (let frameIndex = 0; frameIndex < framesCompared; frameIndex += 1) {
		const referenceFrame = reference[frameIndex];
		const followerFrame = follower[frameIndex];
		if (!referenceFrame || !followerFrame) continue;
		for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
			spatialByTile[tileIndex]?.push(
				clamp01(
					1 -
						tileDistance(referenceFrame.tiles, followerFrame.tiles, tileIndex) *
							2.8,
				),
			);
			if (frameIndex === 0) continue;
			const previousReference = reference[frameIndex - 1];
			const previousFollower = follower[frameIndex - 1];
			if (!previousReference || !previousFollower) continue;
			const offset = featureOffset(tileIndex);
			let transitionDistanceSquared = 0;
			let referenceActivitySquared = 0;
			let followerActivitySquared = 0;
			for (
				let featureIndex = 0;
				featureIndex < FEATURES_PER_TILE;
				featureIndex += 1
			) {
				const referenceDelta =
					(referenceFrame.tiles[offset + featureIndex] ?? 0) -
					(previousReference.tiles[offset + featureIndex] ?? 0);
				const followerDelta =
					(followerFrame.tiles[offset + featureIndex] ?? 0) -
					(previousFollower.tiles[offset + featureIndex] ?? 0);
				const difference = referenceDelta - followerDelta;
				transitionDistanceSquared += difference * difference;
				referenceActivitySquared += referenceDelta * referenceDelta;
				followerActivitySquared += followerDelta * followerDelta;
			}
			transitionByTile[tileIndex]?.push(
				clamp01(
					1 - Math.sqrt(transitionDistanceSquared / FEATURES_PER_TILE) * 7,
				),
			);
			activityByTile[tileIndex]?.push(
				Math.min(
					Math.sqrt(referenceActivitySquared / FEATURES_PER_TILE),
					Math.sqrt(followerActivitySquared / FEATURES_PER_TILE),
				),
			);
		}
	}

	const tileScores = Array.from({ length: tileCount }, (_value, tileIndex) => {
		const activity = median(activityByTile[tileIndex] ?? []);
		const transitionSimilarity = median(transitionByTile[tileIndex] ?? []);
		const spatialSimilarity = median(spatialByTile[tileIndex] ?? []);
		return {
			tileIndex,
			activity,
			spatialSimilarity,
			transitionSimilarity,
			combined: 0.58 * spatialSimilarity + 0.42 * transitionSimilarity,
		};
	});
	const orderedTiles = [...tileScores].sort(
		(left, right) => right.combined - left.combined,
	);
	const retained = orderedTiles.slice(
		0,
		Math.max(1, tileCount - maximumRejectedTiles),
	);
	const rejectedTileIndexes = orderedTiles
		.slice(retained.length)
		.map(({ tileIndex }) => tileIndex);
	const activeTileCount = retained.filter(
		({ activity }) => activity >= 0.012,
	).length;
	if (activeTileCount < DEFAULT_VISUAL_SEQUENCE_CONFIG.minimumActiveTiles) {
		return {
			status: "static",
			similarity: null,
			spatialSimilarity: null,
			transitionSimilarity: null,
			framesCompared,
			activeTileCount,
			rejectedTileIndexes,
		};
	}

	const spatialSimilarity =
		retained.reduce((total, tile) => total + tile.spatialSimilarity, 0) /
		retained.length;
	const transitionSimilarity =
		retained.reduce((total, tile) => total + tile.transitionSimilarity, 0) /
		retained.length;
	const orderedSupport = retained.filter(
		({
			activity,
			spatialSimilarity: spatial,
			transitionSimilarity: transition,
		}) => activity >= 0.012 && spatial >= 0.58 && transition >= 0.62,
	).length;
	const supportFactor = 0.78 + 0.22 * Math.min(1, orderedSupport / 8);
	return {
		status: "scored",
		similarity: clamp01(
			(0.58 * spatialSimilarity + 0.42 * transitionSimilarity) * supportFactor,
		),
		spatialSimilarity,
		transitionSimilarity,
		framesCompared,
		activeTileCount,
		rejectedTileIndexes,
	};
}

export function aggregateVisualWindows(
	comparisons: readonly VisualSequenceComparison[],
): VisualWindowAggregate {
	const scored = comparisons.filter(
		(
			comparison,
		): comparison is VisualSequenceComparison & { similarity: number } =>
			comparison.status === "scored" && comparison.similarity !== null,
	);
	if (scored.length < DEFAULT_VISUAL_SEQUENCE_CONFIG.minimumScoredWindows) {
		const staticCount = comparisons.filter(
			({ status }) => status === "static",
		).length;
		return {
			status: "ambiguous",
			similarity: null,
			spatialSimilarity: null,
			transitionSimilarity: null,
			scoredWindowCount: scored.length,
			reason:
				staticCount > 0
					? "Ordered samples were static or repetitive; manual timing remains required."
					: "Too few ordered frame windows could be compared; manual timing remains required.",
		};
	}

	const similarities = scored.map(({ similarity }) => similarity);
	const conservativeSimilarity =
		0.75 * median(similarities) + 0.25 * Math.min(...similarities);
	const spatialSimilarity = median(
		scored.flatMap(({ spatialSimilarity: value }) =>
			value === null ? [] : [value],
		),
	);
	const transitionSimilarity = median(
		scored.flatMap(({ transitionSimilarity: value }) =>
			value === null ? [] : [value],
		),
	);
	const status =
		conservativeSimilarity >=
		DEFAULT_VISUAL_SEQUENCE_CONFIG.minimumSequenceSimilarity
			? "scored"
			: "ambiguous";
	return {
		status,
		similarity: conservativeSimilarity,
		spatialSimilarity,
		transitionSimilarity,
		scoredWindowCount: scored.length,
		reason:
			status === "scored"
				? "Multiple ordered visual windows supplied consistent local evidence."
				: "Ordered visual windows were contradictory or too weak; manual timing remains required.",
	};
}
