import type { SqliteDatabase } from "./database.ts";

export type TransitionPositionFrame = Readonly<{
	ordinal: number;
	sectionId: string;
	signature: string;
	bytes: readonly number[];
}>;

export type TransitionPositionAggregate = Readonly<{
	sectionId: string;
	fromSignature: string;
	toSignature: string;
	position: number;
	changedCount: number;
	transitionCount: number;
}>;

type TransitionFamily = {
	sectionId: string;
	fromSignature: string;
	toSignature: string;
	transitionCount: number;
	changedCounts: Map<number, number>;
};

function familyKey(sectionId: string, fromSignature: string, toSignature: string): string {
	return `${sectionId}\u0000${fromSignature}\u0000${toSignature}`;
}

/**
 * Recompute indexed transition-position evidence from canonical frames.
 *
 * The source frame owns the section identity of an adjacent pair. A missing
 * byte on either side is a change, so the comparison visits the complete
 * width of the pair rather than only the shorter byte array.
 */
export function deriveTransitionPositionAggregates(
	frames: readonly TransitionPositionFrame[]
): TransitionPositionAggregate[] {
	const families = new Map<string, TransitionFamily>();
	for (let index = 1; index < frames.length; index += 1) {
		const from = frames[index - 1];
		const to = frames[index];
		if (!from || !to) continue;
		const width = Math.max(from.bytes.length, to.bytes.length);
		const changedCounts = new Map<number, number>();
		for (let position = 0; position < width; position += 1) {
			if (from.bytes[position] === to.bytes[position]) continue;
			changedCounts.set(position, 1);
		}
		if (!changedCounts.size) continue;
		const key = familyKey(from.sectionId, from.signature, to.signature);
		const family = families.get(key) ?? {
			sectionId: from.sectionId,
			fromSignature: from.signature,
			toSignature: to.signature,
			transitionCount: 0,
			changedCounts: new Map<number, number>()
		};
		family.transitionCount += 1;
		for (const position of changedCounts.keys()) {
			family.changedCounts.set(position, (family.changedCounts.get(position) ?? 0) + 1);
		}
		families.set(key, family);
	}

	return [...families.values()]
		.flatMap(family => [...family.changedCounts.entries()].map(([position, changedCount]) => ({
			sectionId: family.sectionId,
			fromSignature: family.fromSignature,
			toSignature: family.toSignature,
			position,
			changedCount,
			transitionCount: family.transitionCount
		})))
		.sort((left, right) =>
			left.sectionId.localeCompare(right.sectionId)
			|| left.fromSignature.localeCompare(right.fromSignature)
			|| left.toSignature.localeCompare(right.toSignature)
			|| left.position - right.position
		);
}

/** Persist one profile's derived position aggregates inside the caller's transaction. */
export function persistTransitionPositionAggregates(
	database: SqliteDatabase,
	profileId: string,
	frames: readonly TransitionPositionFrame[]
): void {
	const insert = database.prepare(
		`INSERT INTO frame_transition_positions
		 (profile_id, section_id, from_signature, to_signature, position, changed_count, transition_count)
		 VALUES (@profileId, @sectionId, @fromSignature, @toSignature, @position, @changedCount, @transitionCount)`
	);
	for (const row of deriveTransitionPositionAggregates(frames)) {
		insert.run({ profileId, ...row });
	}
}
