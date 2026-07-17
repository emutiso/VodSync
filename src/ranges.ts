export type ByteRange = { start: number; end: number };

export class ByteRangeCounter {
	readonly #ranges: ByteRange[] = [];
	readonly #maximumRanges: number;
	#requests = 0;
	#requestedBytes = 0;
	#truncated = false;

	constructor(maximumRanges = 256) {
		if (!Number.isSafeInteger(maximumRanges) || maximumRanges < 1) {
			throw new RangeError("maximumRanges must be a positive safe integer");
		}
		this.#maximumRanges = maximumRanges;
	}

	add(start: number, end: number) {
		this.#requests += 1;
		if (
			!Number.isSafeInteger(start) ||
			!Number.isSafeInteger(end) ||
			end <= start
		)
			return;
		this.#requestedBytes += end - start;

		let index = 0;
		while (
			index < this.#ranges.length &&
			(this.#ranges[index]?.end ?? 0) < start
		)
			index += 1;

		let mergedStart = start;
		let mergedEnd = end;
		let deleteCount = 0;
		while (
			index + deleteCount < this.#ranges.length &&
			(this.#ranges[index + deleteCount]?.start ?? Number.POSITIVE_INFINITY) <=
				mergedEnd
		) {
			const existing = this.#ranges[index + deleteCount];
			if (!existing) break;
			mergedStart = Math.min(mergedStart, existing.start);
			mergedEnd = Math.max(mergedEnd, existing.end);
			deleteCount += 1;
		}

		if (deleteCount === 0 && this.#ranges.length >= this.#maximumRanges) {
			this.#truncated = true;
			return;
		}
		this.#ranges.splice(index, deleteCount, {
			start: mergedStart,
			end: mergedEnd,
		});
	}

	summary() {
		return {
			requests: this.#requests,
			requestedBytes: this.#requestedBytes,
			uniqueBytes: this.#ranges.reduce(
				(total, range) => total + range.end - range.start,
				0,
			),
			uniqueBytesExact: !this.#truncated,
			rangesTruncated: this.#truncated,
			ranges: this.#ranges.map((range) => ({ ...range })),
		};
	}
}
