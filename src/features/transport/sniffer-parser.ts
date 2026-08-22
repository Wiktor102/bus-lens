export const SNIFFER_RECORD_MARKER = 0xa5;
export const SNIFFER_STATUS_MARKER = 0xa6;

export type SnifferDirection = "rx" | "tx";

export type SnifferByte = Readonly<{
	value: number;
	direction: SnifferDirection;
}>;

export type SnifferDiagnostic = Readonly<{
	status: number;
	detail: number;
}>;

/**
 * Parses the three-byte records emitted by the directional RS-485 sniffer.
 * Byte and diagnostic records are both three bytes, so the parser never
 * retains more than two bytes between Web Serial reads.
 */
export class SnifferParser {
	private pending: number[] = [];
	private readonly onByte: (byte: SnifferByte) => void;
	private readonly onDiagnostic?: (diagnostic: SnifferDiagnostic) => void;

	constructor(onByte: (byte: SnifferByte) => void, onDiagnostic?: (diagnostic: SnifferDiagnostic) => void) {
		this.onByte = onByte;
		this.onDiagnostic = onDiagnostic;
	}

	push(chunk: Uint8Array): void {
		const bytes = this.pending.length ? [...this.pending, ...chunk] : [...chunk];
		this.pending = [];

		let index = 0;
		while (index < bytes.length) {
			while (index < bytes.length && bytes[index] !== SNIFFER_RECORD_MARKER && bytes[index] !== SNIFFER_STATUS_MARKER) index += 1;
			if (index >= bytes.length) return;
			const marker = bytes[index];

			if (index + 1 >= bytes.length) {
				this.pending = bytes.slice(index);
				return;
			}

			if (index + 2 >= bytes.length) {
				this.pending = bytes.slice(index);
				return;
			}

			if (marker === SNIFFER_STATUS_MARKER) {
				this.onDiagnostic?.({ status: bytes[index + 1], detail: bytes[index + 2] });
				index += 3;
				continue;
			}

			const direction = bytes[index + 1];
			if (direction !== 0 && direction !== 1) {
				index += 1;
				continue;
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
