export const MICROSECONDS_PER_SECOND = 1_000_000;

export type PlaybackOrigin = {
	rawTimestampAtMediaTimeZeroUs: number;
	source: "container-first-timestamp" | "assumed-zero";
};

function finiteInteger(value: number, label: string) {
	if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
	const integer = Math.round(value);
	if (!Number.isSafeInteger(integer))
		throw new RangeError(`${label} exceeds integer-microsecond range`);
	return integer;
}

export function secondsToMicroseconds(seconds: number) {
	return finiteInteger(seconds * MICROSECONDS_PER_SECOND, "seconds");
}

export function microsecondsToSeconds(microseconds: number) {
	return finiteInteger(microseconds, "microseconds") / MICROSECONDS_PER_SECOND;
}

export function localToReferenceUs(localTimeUs: number, offsetUs: number) {
	return finiteInteger(
		finiteInteger(localTimeUs, "localTimeUs") +
			finiteInteger(offsetUs, "offsetUs"),
		"referenceTimeUs",
	);
}

export function referenceToLocalUs(referenceTimeUs: number, offsetUs: number) {
	return finiteInteger(
		finiteInteger(referenceTimeUs, "referenceTimeUs") -
			finiteInteger(offsetUs, "offsetUs"),
		"localTimeUs",
	);
}

export function isLocalTimeCovered(localTimeUs: number, durationUs: number) {
	const local = finiteInteger(localTimeUs, "localTimeUs");
	const duration = finiteInteger(durationUs, "durationUs");
	return local >= 0 && local < duration;
}

export function rawTimestampToMediaTimeUs(
	rawTimestampUs: number,
	origin: PlaybackOrigin,
) {
	return finiteInteger(
		finiteInteger(rawTimestampUs, "rawTimestampUs") -
			finiteInteger(
				origin.rawTimestampAtMediaTimeZeroUs,
				"rawTimestampAtMediaTimeZeroUs",
			),
		"mediaTimeUs",
	);
}

export function mediaTimeToRawTimestampUs(
	mediaTimeUs: number,
	origin: PlaybackOrigin,
) {
	return finiteInteger(
		finiteInteger(mediaTimeUs, "mediaTimeUs") +
			finiteInteger(
				origin.rawTimestampAtMediaTimeZeroUs,
				"rawTimestampAtMediaTimeZeroUs",
			),
		"rawTimestampUs",
	);
}

export function rawLagToPlaybackOffsetUs(
	rawLagUs: number,
	referenceOrigin: PlaybackOrigin,
	followerOrigin: PlaybackOrigin,
) {
	return finiteInteger(
		finiteInteger(rawLagUs, "rawLagUs") -
			finiteInteger(
				referenceOrigin.rawTimestampAtMediaTimeZeroUs,
				"referenceRawTimestampAtMediaTimeZeroUs",
			) +
			finiteInteger(
				followerOrigin.rawTimestampAtMediaTimeZeroUs,
				"followerRawTimestampAtMediaTimeZeroUs",
			),
		"playbackOffsetUs",
	);
}
