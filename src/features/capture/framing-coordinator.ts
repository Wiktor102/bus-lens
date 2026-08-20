import type { FramingSectionRequest } from "../../persistence/archive-client.ts";

type FramingQueue = {
	pending: FramingSectionRequest[] | null;
	active: FramingSectionRequest[] | null;
	retries: number;
	running: Promise<void> | null;
	blocked: boolean;
};

export type FramingCoordinatorDependencies = {
	/** Send one intent to the server and install its authoritative projection before returning. */
	write: (captureId: string, sections: readonly FramingSectionRequest[]) => Promise<void>;
	/** Reload the acknowledged SQLite projection. This must not apply a pending intent itself. */
	reload: (captureId: string, preserveIntent: boolean) => Promise<void>;
	/** Rebuild the browser preview from an intent after a newer intent is still queued. */
	applyPending: (captureId: string, sections: readonly FramingSectionRequest[]) => void;
	onTerminalFailure: (captureId: string, error: unknown) => void;
	onStateChange?: (captureId: string) => void;
};

export type FramingCoordinator = {
	enqueue: (captureId: string, sections: readonly FramingSectionRequest[]) => void;
	isPending: (captureId: string) => boolean;
	isBlocked: (captureId: string) => boolean;
	pendingIntent: (captureId: string) => readonly FramingSectionRequest[] | null;
	activeIntent: (captureId: string) => readonly FramingSectionRequest[] | null;
	acknowledgeAuthoritativeRefresh: (captureId: string) => void;
	waitFor: (captureId: string) => Promise<void>;
};

function cloneSections(sections: readonly FramingSectionRequest[]): FramingSectionRequest[] {
	return sections.map(section => ({ ...section }));
}

/**
 * Serializes framing intents per capture. A reframe creates a new immutable
 * server profile, so the next request must not start until the previous
 * profile has been reloaded and installed as the browser's authority.
 */
export function createFramingCoordinator(dependencies: FramingCoordinatorDependencies): FramingCoordinator {
	const queues = new Map<string, FramingQueue>();

	function notify(captureId: string): void {
		dependencies.onStateChange?.(captureId);
	}

	function queueFor(captureId: string): FramingQueue {
		const existing = queues.get(captureId);
		if (existing) return existing;
		const queue: FramingQueue = { pending: null, active: null, retries: 0, running: null, blocked: false };
		queues.set(captureId, queue);
		return queue;
	}

	function clearQueue(captureId: string, queue: FramingQueue): void {
		if (queue.pending || queue.active || queue.running || queue.blocked) return;
		if (queues.get(captureId) === queue) queues.delete(captureId);
	}

	async function reloadForRetry(captureId: string, queue: FramingQueue, sections: readonly FramingSectionRequest[]): Promise<boolean> {
		queue.pending ||= cloneSections(sections);
		notify(captureId);
		try {
			await dependencies.reload(captureId, true);
			if (queue.pending) dependencies.applyPending(captureId, queue.pending);
			return true;
		} catch (reloadError) {
			queue.pending = null;
			queue.active = null;
			let restored = false;
			try {
				await dependencies.reload(captureId, false);
				restored = true;
			} catch {
				// Keep the queue blocked below: the optimistic projection is still
				// visible and has not been replaced by an acknowledged projection.
			}
			if (!restored) queue.blocked = true;
			notify(captureId);
			dependencies.onTerminalFailure(captureId, reloadError);
			return false;
		}
	}

	async function drain(captureId: string, queue: FramingQueue): Promise<void> {
		while (queue.pending) {
			const sections = queue.pending;
			queue.pending = null;
			queue.active = cloneSections(sections);
			notify(captureId);
			try {
				await dependencies.write(captureId, sections);
				queue.active = null;
				queue.retries = 0;
				if (queue.pending) dependencies.applyPending(captureId, queue.pending);
			} catch (error) {
				if (queue.retries < 1) {
					queue.retries += 1;
					if (!await reloadForRetry(captureId, queue, sections)) break;
					continue;
				}

				// A terminal failure must leave the browser on the last acknowledged
				// projection. Clear the intent before reloading so the reload cannot
				// immediately reapply a deleted or otherwise failed local section.
				queue.pending = null;
				queue.active = null;
				let restored = false;
				try {
					await dependencies.reload(captureId, false);
					restored = true;
				} catch {
					// Keep the queue blocked below: the optimistic projection is still
					// visible and has not been replaced by an acknowledged projection.
				}
				if (!restored) queue.blocked = true;
				notify(captureId);
				dependencies.onTerminalFailure(captureId, error);
				break;
			}
		}
	}

	function enqueue(captureId: string, sections: readonly FramingSectionRequest[]): void {
		const queue = queueFor(captureId);
		if (queue.blocked) return;
		queue.pending = cloneSections(sections);
		notify(captureId);
		if (queue.running) return;
		queue.running = drain(captureId, queue).finally(() => {
			queue.running = null;
			queue.retries = 0;
			notify(captureId);
			clearQueue(captureId, queue);
		});
	}

	function isPending(captureId: string): boolean {
		const queue = queues.get(captureId);
		return Boolean(queue?.blocked || queue?.pending || queue?.running);
	}

	function isBlocked(captureId: string): boolean {
		return Boolean(queues.get(captureId)?.blocked);
	}

	function pendingIntent(captureId: string): readonly FramingSectionRequest[] | null {
		const pending = queues.get(captureId)?.pending;
		return pending ? cloneSections(pending) : null;
	}

	function activeIntent(captureId: string): readonly FramingSectionRequest[] | null {
		const active = queues.get(captureId)?.active;
		return active ? cloneSections(active) : null;
	}

	function acknowledgeAuthoritativeRefresh(captureId: string): void {
		const queue = queues.get(captureId);
		if (!queue?.blocked) return;
		queue.blocked = false;
		notify(captureId);
		clearQueue(captureId, queue);
	}

	async function waitFor(captureId: string): Promise<void> {
		while (true) {
			const queue = queues.get(captureId);
			if (!queue) return;
			if (queue.running) {
				await queue.running;
				continue;
			}
			if (!queue.pending) return;
			await Promise.resolve();
		}
	}

	return { enqueue, isPending, isBlocked, pendingIntent, activeIntent, acknowledgeAuthoritativeRefresh, waitFor };
}
