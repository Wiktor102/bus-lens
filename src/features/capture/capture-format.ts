export const CAPTURE_INPUT_FORMATS = {
	BINARY: "binary",
	SNIFFER: "sniffer"
} as const;

export type CaptureInputFormat = (typeof CAPTURE_INPUT_FORMATS)[keyof typeof CAPTURE_INPUT_FORMATS];

export const SNIFFER_BAUD_RATE = 28_800;

export function isSnifferInputFormat(value: unknown): boolean {
	return value === CAPTURE_INPUT_FORMATS.SNIFFER;
}
