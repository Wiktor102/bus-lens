export type CaptureChunkSegment = {
	timestamp: number;
	direction: "rx" | "tx";
	bytes: number[];
};

export type AppendCaptureChunkRequest = {
	captureId: string;
	requestId: string;
	sessionId: string;
	sequence: number;
	expectedStartOffset: number;
	segments: CaptureChunkSegment[];
};

export type AppendCaptureChunkResponse = {
	nextSequence: number;
	nextRawOffset: number;
	dataRevision: number;
	acceptedStartOffset: number;
	acceptedEndOffset: number;
};

export type CaptureAppendTransport = {
	appendChunk: (request: AppendCaptureChunkRequest) => Promise<AppendCaptureChunkResponse>;
};

export type CaptureAppendBoundary = {
	sessionId: string;
	nextChunkSequence: number;
	nextRawOffset: number;
	dataRevision: number;
};

export type CaptureAppendQueueOptions = {
	generateRequestId?: () => string;
	backpressureBytes?: number;
	onPersistentError?: (captureId: string, error: unknown) => void;
	onBackpressureChange?: (captureId: string, active: boolean) => void;
};

type QueuedBatch = {
	requestId: string;
	segments: CaptureChunkSegment[];
	byteCount: number;
};

type CaptureQueueState = CaptureAppendBoundary & {
	pending: CaptureChunkSegment[];
	batches: QueuedBatch[];
	drainPromise: Promise<void> | null;
	error: unknown;
	backpressured: boolean;
};

function byteCount(segments: readonly CaptureChunkSegment[]): number {
	return segments.reduce((total, segment) => total + segment.bytes.length, 0);
}

function copySegment(segment: CaptureChunkSegment): CaptureChunkSegment {
	return { timestamp: segment.timestamp, direction: segment.direction, bytes: [...segment.bytes] };
}

export class CaptureAppendQueue {
	private readonly states = new Map<string, CaptureQueueState>();
	private readonly generateRequestId: () => string;
	private readonly backpressureBytes: number;
	private readonly transport: CaptureAppendTransport;
	private readonly options: CaptureAppendQueueOptions;

	constructor(
		transport: CaptureAppendTransport,
		options: CaptureAppendQueueOptions = {}
	) {
		this.transport = transport;
		this.options = options;
		this.generateRequestId = options.generateRequestId ?? (() => crypto.randomUUID());
		this.backpressureBytes = options.backpressureBytes ?? 32_768;
	}

	start(captureId: string, boundary: CaptureAppendBoundary): void {
		if (this.hasUnacknowledgedBytes(captureId)) throw new Error(`capture ${captureId} still has unacknowledged bytes`);
		this.states.set(captureId, {
			...boundary,
			pending: [],
			batches: [],
			drainPromise: null,
			error: null,
			backpressured: false
		});
	}

	enqueue(captureId: string, segment: CaptureChunkSegment): void {
		const state = this.requireState(captureId);
		if (!segment.bytes.length) return;
		state.pending.push(copySegment(segment));
		this.updateBackpressure(captureId, state);
	}

	flush(captureId: string): Promise<void> {
		const state = this.requireState(captureId);
		if (state.pending.length) {
			const segments = state.pending.splice(0).map(copySegment);
			state.batches.push({ requestId: this.generateRequestId(), byteCount: byteCount(segments), segments });
		}
		this.updateBackpressure(captureId, state);
		return this.ensureDrain(captureId, state);
	}

	retry(captureId: string): Promise<void> {
		const state = this.requireState(captureId);
		state.error = null;
		return this.ensureDrain(captureId, state);
	}

	async drain(captureId: string): Promise<void> {
		await this.flush(captureId);
		const state = this.requireState(captureId);
		if (state.pending.length || state.batches.length) throw state.error ?? new Error(`capture ${captureId} append queue did not drain`);
	}

	boundary(captureId: string): CaptureAppendBoundary {
		const state = this.requireState(captureId);
		return {
			sessionId: state.sessionId,
			nextChunkSequence: state.nextChunkSequence,
			nextRawOffset: state.nextRawOffset,
			dataRevision: state.dataRevision
		};
	}

	error(captureId: string): unknown {
		return this.states.get(captureId)?.error ?? null;
	}

	isBackpressured(captureId: string): boolean {
		return this.states.get(captureId)?.backpressured ?? false;
	}

	hasUnacknowledgedBytes(captureId?: string): boolean {
		if (captureId) {
			const state = this.states.get(captureId);
			return Boolean(state && (state.pending.length || state.batches.length));
		}
		return [...this.states.values()].some(state => state.pending.length > 0 || state.batches.length > 0);
	}

	recoverySegments(captureId: string): CaptureChunkSegment[] {
		const state = this.requireState(captureId);
		return [...state.batches.flatMap(batch => batch.segments), ...state.pending].map(copySegment);
	}

	private requireState(captureId: string): CaptureQueueState {
		const state = this.states.get(captureId);
		if (!state) throw new Error(`capture ${captureId} has no active append session`);
		return state;
	}

	private ensureDrain(captureId: string, state: CaptureQueueState): Promise<void> {
		if (state.error) return Promise.reject(state.error);
		if (state.drainPromise) return state.drainPromise;
		state.drainPromise = this.runDrain(captureId, state).finally(() => {
			state.drainPromise = null;
			this.updateBackpressure(captureId, state);
		});
		return state.drainPromise;
	}

	private async runDrain(captureId: string, state: CaptureQueueState): Promise<void> {
		while (state.batches.length && !state.error) {
			const batch = state.batches[0];
			try {
				const response = await this.transport.appendChunk({
					captureId,
					requestId: batch.requestId,
					sessionId: state.sessionId,
					sequence: state.nextChunkSequence,
					expectedStartOffset: state.nextRawOffset,
					segments: batch.segments.map(copySegment)
				});
				if (
					response.acceptedStartOffset !== state.nextRawOffset ||
					response.acceptedEndOffset !== state.nextRawOffset + batch.byteCount
				) {
					throw new Error("append acknowledgement does not match submitted byte span");
				}
				state.nextChunkSequence = response.nextSequence;
				state.nextRawOffset = response.nextRawOffset;
				state.dataRevision = response.dataRevision;
				state.batches.shift();
				this.updateBackpressure(captureId, state);
			} catch (error) {
				state.error = error;
				this.options.onPersistentError?.(captureId, error);
				throw error;
			}
		}
	}

	private updateBackpressure(captureId: string, state: CaptureQueueState): void {
		const queuedBytes = byteCount(state.pending) + state.batches.reduce((total, batch) => total + batch.byteCount, 0);
		const active = queuedBytes > this.backpressureBytes;
		if (active === state.backpressured) return;
		state.backpressured = active;
		this.options.onBackpressureChange?.(captureId, active);
	}
}
