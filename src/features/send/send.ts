export type SendQueueItem = {
	id: string;
	bytes: number[];
	createdAt: number;
};

export type SendHistoryItem = {
	id: string;
	timestamp: number;
	bytes: number[];
	origin: string;
	ok: boolean;
	error: string;
	captureId: string | null;
};

export type SendSnapshot = {
	connected: boolean;
	recording: boolean;
	sendInFlight: boolean;
	queueRunning: boolean;
	stopQueueRequested: boolean;
	draft: string;
	delayMs: number;
	queue: SendQueueItem[];
	history: SendHistoryItem[];
};

export type ParsedTransmitHex = {
	bytes: Uint8Array | null;
	message: string;
};

export type SendViewModel = {
	connected: boolean;
	statusText: "QUEUE RUNNING" | "READY" | "OFFLINE";
	statusClassName: string;
	connectionHint: string;
	parsedDraft: ParsedTransmitHex;
	draftHintClassName: string;
	sendDisabled: boolean;
	queueDisabled: boolean;
	queueCount: number;
	historyCount: number;
	queueTabCountHidden: boolean;
	runQueueHidden: boolean;
	runQueueDisabled: boolean;
	stopQueueHidden: boolean;
	stopQueueDisabled: boolean;
	stopQueueText: "Stop" | "Stopping…";
	clearQueueDisabled: boolean;
	clearHistoryDisabled: boolean;
	replayDisabled: boolean;
};

export const EMPTY_SEND_SNAPSHOT: SendSnapshot = {
	connected: false,
	recording: false,
	sendInFlight: false,
	queueRunning: false,
	stopQueueRequested: false,
	draft: "",
	delayMs: 100,
	queue: [],
	history: []
};

export function parseTransmitHex(value: string): ParsedTransmitHex {
	const compact = value.replace(/[\s,:-]/g, "");
	if (!compact) return { bytes: new Uint8Array(), message: "Enter whole bytes as hex." };
	if (!/^[0-9a-f]+$/i.test(compact) || compact.length % 2)
		return { bytes: null, message: "Use complete hex bytes, for example C2 08 5D." };
	return {
		bytes: Uint8Array.from(compact.match(/.{2}/g)!.map(pair => parseInt(pair, 16))),
		message: `${compact.length / 2} byte${compact.length === 2 ? "" : "s"} ready to send.`
	};
}

export function deriveSendViewModel(snapshot: SendSnapshot): SendViewModel {
	const parsedDraft = parseTransmitHex(snapshot.draft);
	const hasValidDraft = Boolean(parsedDraft.bytes?.length);
	const sendReady = Boolean(
		hasValidDraft && snapshot.connected && !snapshot.sendInFlight && !snapshot.queueRunning
	);

	return {
		connected: snapshot.connected,
		statusText: snapshot.queueRunning ? "QUEUE RUNNING" : snapshot.connected ? "READY" : "OFFLINE",
		statusClassName: [
			"send-status",
			snapshot.connected ? "connected" : "",
			snapshot.queueRunning ? "running" : ""
		]
			.filter(Boolean)
			.join(" "),
		connectionHint: snapshot.connected
			? snapshot.recording
				? "Sent bytes are recorded as TX in the active capture and in local send history."
				: "Capture is inactive. Sends are kept in the separate local history."
			: "Connect a serial port to send. Drafts and queue stay saved locally.",
		parsedDraft,
		draftHintClassName: [
			"transmit-hint",
			sendReady ? "ready" : "",
			parsedDraft.bytes === null ? "invalid" : ""
		]
			.filter(Boolean)
			.join(" "),
		sendDisabled: !sendReady,
		queueDisabled: !hasValidDraft || snapshot.queueRunning,
		queueCount: snapshot.queue.length,
		historyCount: snapshot.history.length,
		queueTabCountHidden: snapshot.queue.length === 0,
		runQueueHidden: snapshot.queueRunning,
		runQueueDisabled:
			!snapshot.connected ||
			snapshot.queue.length === 0 ||
			snapshot.queueRunning ||
			snapshot.sendInFlight,
		stopQueueHidden: !snapshot.queueRunning,
		stopQueueDisabled: snapshot.stopQueueRequested,
		stopQueueText: snapshot.stopQueueRequested ? "Stopping…" : "Stop",
		clearQueueDisabled: snapshot.queue.length === 0 || snapshot.queueRunning,
		clearHistoryDisabled: snapshot.history.length === 0,
		replayDisabled: !snapshot.connected || snapshot.sendInFlight || snapshot.queueRunning
	};
}

export function formatSendTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString("en-GB", {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hour12: false,
		fractionalSecondDigits: 3
	});
}
