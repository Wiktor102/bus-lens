export const SNIFFER_RECORD_MARKER = 0xa5;

export type SnifferDirection = "rx" | "tx";

export type SnifferByte = Readonly<{
	value: number;
	direction: SnifferDirection;
}>;

/**
 * Parses the three-byte records emitted by the directional RS-485 sniffer.
 * Only a marker or a marker plus a valid direction can be incomplete, so the
 * parser never retains more than two bytes between Web Serial reads.
 */
export class SnifferParser {
	private pending: number[] = [];
	private readonly onByte: (byte: SnifferByte) => void;

	constructor(onByte: (byte: SnifferByte) => void) {
		this.onByte = onByte;
	}

	push(chunk: Uint8Array): void {
		const bytes = this.pending.length ? [...this.pending, ...chunk] : [...chunk];
		this.pending = [];

		let index = 0;
		while (index < bytes.length) {
			while (index < bytes.length && bytes[index] !== SNIFFER_RECORD_MARKER) index += 1;
			if (index >= bytes.length) return;

			if (index + 1 >= bytes.length) {
				this.pending = bytes.slice(index);
				return;
			}

			const direction = bytes[index + 1];
			if (direction !== 0 && direction !== 1) {
				index += 1;
				continue;
			}

			if (index + 2 >= bytes.length) {
				this.pending = bytes.slice(index, index + 2);
				return;
			}

			this.onByte({
				value: bytes[index + 2],
				direction: direction === 0 ? "rx" : "tx"
			});
			index += 3;
		}
	}

	reset(): void {
		this.pending = [];
	}

	get pendingByteCount(): number {
		return this.pending.length;
	}
}
