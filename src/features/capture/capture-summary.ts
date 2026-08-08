export type RawByteRecord = {
	/** Absolute byte-stream offset. Legacy records are normalized on load. */
	rawOffset?: number;
	value: number;
	timestamp: number;
	direction?: string;
	sessionId?: string;
	hidden?: boolean;
};

export type RecordingSession = {
	id: string;
	firstReceivedAt?: number;
	lastReceivedAt?: number;
};

export type FramedMessage = {
	bytes: number[];
	hiddenBytes?: boolean[];
};

export type LegacyFramedMessage = FramedMessage & {
	timestamp: number;
	byteTimestamps?: number[];
};

export type CaptureSummaryData = {
	byteStream?: RawByteRecord[];
	captureSessions?: RecordingSession[];
	description?: string;
	notes?: Array<{ type?: string; text?: string; createdAt?: number; id?: string }>;
};

const createId: () => string = () => crypto.randomUUID();

function timestamp(value: unknown) {
	const result = Number(value);
	return Number.isFinite(result) ? result : undefined;
}

function receivedRecords(byteStream: RawByteRecord[] = []) {
	return byteStream.filter(record => record?.direction !== "tx" && timestamp(record.timestamp) !== undefined);
}

export function signatureForMessage(message: FramedMessage) {
	return message.bytes
		.filter((_, index) => !message.hiddenBytes?.[index])
		.map(byte => Number(byte).toString(16).padStart(2, "0").toUpperCase())
		.join(" ");
}

export function reconstructLegacyByteStream(messages: LegacyFramedMessage[] = []): RawByteRecord[] {
	return messages.flatMap(message =>
		message.bytes.map((value, index) => ({
			value,
			timestamp: message.byteTimestamps?.[index] ?? message.timestamp,
			hidden: Boolean(message.hiddenBytes?.[index])
		}))
	);
}

export function countDistinctMessageSignatures(messages: FramedMessage[] = []) {
	return new Set(messages.map(signatureForMessage)).size;
}

export function countReceivedRawBytes(byteStream: RawByteRecord[] = []) {
	return byteStream.filter(record => record?.direction !== "tx").length;
}

export function sumRecordingSessionDurations(sessions: RecordingSession[] = []) {
	return sessions.reduce((total, session) => {
		const firstReceivedAt = timestamp(session?.firstReceivedAt);
		const lastReceivedAt = timestamp(session?.lastReceivedAt);
		return total + (firstReceivedAt === undefined || lastReceivedAt === undefined ? 0 : Math.max(0, lastReceivedAt - firstReceivedAt));
	}, 0);
}

export function normalizeDescription(value: unknown) {
	return String(value || "").replace(/\s+/g, " ").trim();
}

export function normalizeCaptureSummaryData<T extends CaptureSummaryData>(capture: T, generateId = createId): T {
	const byteStream = Array.isArray(capture.byteStream) ? capture.byteStream : [];
	const hasPersistedSessions = Array.isArray(capture.captureSessions);
	const normalizedSessions = hasPersistedSessions
		? (capture.captureSessions || [])
				.filter(session => session && typeof session === "object")
				.map(session => {
					const firstReceivedAt = timestamp(session.firstReceivedAt);
					const lastReceivedAt = timestamp(session.lastReceivedAt);
					return {
						id: String(session.id || generateId()),
						...(firstReceivedAt === undefined ? {} : { firstReceivedAt }),
						...(lastReceivedAt === undefined ? {} : { lastReceivedAt })
					};
				})
		: (() => {
				const received = receivedRecords(byteStream);
				if (!received.length) return [];
				return [
					{
						id: generateId(),
						firstReceivedAt: Number(received[0].timestamp),
						lastReceivedAt: Number(received[received.length - 1].timestamp)
					}
				];
			})();

	const legacyCaptureNotes = (Array.isArray(capture.notes) ? capture.notes : [])
		.filter(note => note?.type === "capture")
		.sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
		.map(note => normalizeDescription(note.text))
		.filter(Boolean);
	const descriptionParts = [normalizeDescription(capture.description), ...legacyCaptureNotes].filter(Boolean);

	capture.captureSessions = normalizedSessions;
	capture.description = descriptionParts.join("\n");
	if (Array.isArray(capture.notes)) capture.notes = capture.notes.filter(note => note?.type !== "capture");
	return capture;
}

export function recordReceivedByte(session: RecordingSession | undefined, timestampValue: number) {
	if (!session || !Number.isFinite(timestampValue)) return;
	if (session.firstReceivedAt === undefined) session.firstReceivedAt = timestampValue;
	session.lastReceivedAt = timestampValue;
}
