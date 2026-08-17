import assert from "node:assert/strict";
import test from "node:test";
import { ArchiveRepository } from "../server/archive-repository.ts";
import {
	CanonicalCaptureCommandService,
	type FramingSectionViewRequest,
	type ReframeRequest as ServerReframeRequest
} from "../server/canonical-capture-command-service.ts";
import { openDatabase } from "../server/database.ts";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import type { Capture } from "../src/features/capture/capture-framing.ts";
import type { CaptureWriter, ReframeRequest } from "../src/persistence/archive-client.ts";
import type { AppState } from "../src/shared/app-state.ts";
import {
	EMPTY_VIEW_STATE_SNAPSHOT,
	getSectionViewPreference,
	reduceViewState,
	type ViewStateSnapshot
} from "../src/shared/view-state.ts";

const framing = [{ start: 0, framingMode: "length", frameSize: 2, collapseRuns: false, collapsed: false }] as const;

type FixtureOptions = {
	reframe?: (request: ReframeRequest, service: CanonicalCaptureCommandService) => Promise<unknown>;
	refresh?: () => Promise<Capture>;
};

type Fixture = {
	database: ReturnType<typeof openDatabase>;
	service: CanonicalCaptureCommandService;
	repository: ArchiveRepository;
	capture: Capture;
	controller: ReturnType<typeof createCaptureController>;
	errors: unknown[];
	getViewState: () => ViewStateSnapshot;
	getSectionViewRequestCount: () => number;
};

function recordAndFinalize(service: CanonicalCaptureCommandService, captureId: string): void {
	service.createCapture({ captureId, framing, inputFormat: "binary" });
	service.startSession({ captureId, sessionId: `${captureId}-session` });
	const append = service.appendChunk({
		captureId,
		sessionId: `${captureId}-session`,
		requestId: `${captureId}-request`,
		sequence: 0,
		expectedStartOffset: 0,
		bytes: [1, 2, 3, 4]
	});
	service.finalizeSession({ captureId, sessionId: `${captureId}-session`, expectedDataRevision: append.dataRevision });
}

function readCapture(repository: ArchiveRepository, captureId: string): Capture {
	const record = repository.getCapture(captureId);
	assert.ok(record, `capture ${captureId} should exist`);
	return record.document as unknown as Capture;
}

function makeFixture(name: string, options: FixtureOptions = {}): Fixture {
	const database = openDatabase(":memory:");
	const service = new CanonicalCaptureCommandService(database);
	const repository = new ArchiveRepository(database);
	recordAndFinalize(service, name);
	const capture = readCapture(repository, name);
	const state = { captures: [capture], folders: [] } as unknown as AppState;
	const errors: unknown[] = [];
	let viewState = EMPTY_VIEW_STATE_SNAPSHOT;
	let sectionViewRequestCount = 0;
	const writer = {
		updateFramingDraft: async (request: Parameters<CaptureWriter["updateFramingDraft"]>[0]) => service.updateFramingDraft(request),
		reframe: async (request: ReframeRequest) => {
			if (options.reframe) return options.reframe(request, service);
			return service.reframe(request as ServerReframeRequest);
		},
		updateFramingSectionView: async (request: FramingSectionViewRequest) => {
			sectionViewRequestCount += 1;
			return service.updateFramingSectionView(request);
		},
		setFrameVisibility: async (request: Parameters<CaptureWriter["setFrameVisibility"]>[0]) => service.setFrameVisibility(request),
		setByteVisibility: async (request: Parameters<CaptureWriter["setByteVisibility"]>[0]) => service.setByteVisibility(request)
	} as unknown as CaptureWriter;
	let activeId: string | null = name;
	const controller = createCaptureController({
		state,
		capture: () => capture,
		getCapture: () => capture,
		getActiveId: () => activeId,
		setActiveId: captureId => { activeId = captureId ? String(captureId) : null; },
		setActiveCapture: next => {
			if (next && next !== capture) Object.assign(capture, next);
		},
		render: () => {},
		renderMessages: () => {},
		showToast: () => {},
		confirm: () => true,
		transport: { isRecording: () => false, stopRecording: async () => {} },
		publishDialogCommand: () => {},
		captureWriter: writer,
		isCanonicalCapture: () => true,
		refreshCapture: async () => options.refresh ? options.refresh() : readCapture(repository, name),
		seedSectionViewState: (captureId, sections) => {
			viewState = reduceViewState(viewState, { type: "seed-section-preferences", captureId, sections });
		},
		setSectionViewState: (captureId, rawStart, patch) => {
			viewState = reduceViewState(viewState, { type: "set-section-preference", captureId, rawStart, patch });
		},
		moveSectionViewState: (captureId, fromRawStart, toRawStart) => {
			viewState = reduceViewState(viewState, { type: "move-section-preference", captureId, fromRawStart, toRawStart });
		},
		deleteSectionViewState: (captureId, rawStart) => {
			viewState = reduceViewState(viewState, { type: "delete-section-preference", captureId, rawStart });
		},
		clearSectionViewState: captureId => {
			viewState = reduceViewState(viewState, { type: "clear-section-preferences", captureId });
		},
		reportPersistenceFailure: (_captureId, error) => { errors.push(error); }
	});
	return {
		database,
		service,
		repository,
		capture,
		controller,
		errors,
		getViewState: () => viewState,
		getSectionViewRequestCount: () => sectionViewRequestCount
	};
}

function closeFixture(fixture: Fixture): void {
	fixture.database.close();
}

function activeProfileId(fixture: Fixture): string {
	const row = fixture.database
		.prepare("SELECT active_framing_profile_id AS profileId FROM captures WHERE id = @captureId")
		.get({ captureId: fixture.capture.id }) as { profileId: string };
	return row.profileId;
}

function activeSectionRows(fixture: Fixture): Array<{ id: string; start: number; collapseRuns: number; collapsed: number }> {
	return fixture.database
		.prepare(
			`SELECT id, start_offset AS start, collapse_runs AS collapseRuns, collapsed
			 FROM framing_sections
			 WHERE capture_id = @captureId AND profile_id = (SELECT active_framing_profile_id FROM captures WHERE id = @captureId)
			 ORDER BY position`
		)
		.all({ captureId: fixture.capture.id }) as Array<{ id: string; start: number; collapseRuns: number; collapsed: number }>;
}

test("reframe reloads canonical frame IDs before frame visibility uses them", async () => {
	const fixture = makeFixture("authoritative-visibility");
	try {
		const initialSectionId = String(fixture.capture.frameSections?.[0]?.id);
		fixture.controller.setSectionFrameSize(initialSectionId, 1);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);

		const profileId = activeProfileId(fixture);
		assert.equal(fixture.capture.activeFramingProfileId, profileId);
		const frameRows = fixture.database
			.prepare("SELECT id FROM materialized_frames WHERE capture_id = @captureId AND profile_id = @profileId ORDER BY ordinal")
			.all({ captureId: fixture.capture.id, profileId }) as Array<{ id: string }>;
		assert.deepEqual(fixture.capture.messages?.map(message => message.id), frameRows.map(row => row.id));
		assert.equal(frameRows.length, 4);

		const result = fixture.service.setFrameVisibility({
			captureId: fixture.capture.id!,
			frameId: String(fixture.capture.messages?.[0]?.id),
			hidden: true
		});
		assert.equal(result.hidden, true);
		assert.equal(
			(fixture.database.prepare("SELECT COUNT(*) AS count FROM frame_visibility").get() as { count: number }).count,
			1
		);
	} finally {
		closeFixture(fixture);
	}
});

test("rapid section create, move, and delete coalesces to the final authoritative state", async () => {
	const fixture = makeFixture("authoritative-rapid-sections");
	try {
		const message = fixture.capture.messages?.[1];
		assert.ok(message);
		fixture.controller.startSectionAtByte(String(message.id), 0);
		const optimisticSectionId = String(fixture.capture.frameSections?.at(-1)?.id);
		fixture.controller.moveSection(optimisticSectionId, "byte-before");
		fixture.controller.deleteSection(optimisticSectionId);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);

		const sections = fixture.capture.frameSections ?? [];
		const serverSections = activeSectionRows(fixture);
		assert.equal(sections.length, 1);
		assert.deepEqual(
			sections.map(section => ({ id: section.id, start: section.start, collapseRuns: Number(Boolean(section.collapseRuns)), collapsed: Number(Boolean(section.collapsed)) })),
			serverSections
		);
		assert.deepEqual(
			fixture.capture.messages?.map(messageItem => messageItem.id),
			(fixture.database
				.prepare("SELECT id FROM materialized_frames WHERE capture_id = @captureId AND profile_id = (SELECT active_framing_profile_id FROM captures WHERE id = @captureId) ORDER BY ordinal")
				.all({ captureId: fixture.capture.id }) as Array<{ id: string }>).map(row => row.id)
		);
	} finally {
		closeFixture(fixture);
	}
});

test("a failed section deletion rolls back to the last acknowledged SQLite projection", async () => {
	let failReframes = false;
	const fixture = makeFixture("authoritative-delete-rollback", {
		reframe: async (request, service) => {
			if (failReframes) throw new Error("reframe deliberately failed");
			return service.reframe(request as ServerReframeRequest);
		}
	});
	try {
		const message = fixture.capture.messages?.[1];
		assert.ok(message);
		fixture.controller.startSectionAtByte(String(message.id), 0);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);
		const sectionId = String(fixture.capture.frameSections?.[1]?.id);
		failReframes = true;

		fixture.controller.deleteSection(sectionId);
		assert.equal(fixture.capture.frameSections?.length, 1);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);

		assert.equal(fixture.capture.frameSections?.length, 2);
		assert.equal(activeSectionRows(fixture).length, 2);
		assert.ok(fixture.errors.length >= 1);
	} finally {
		closeFixture(fixture);
	}
});

test("failed rollback keeps the optimistic framing projection blocked until refresh recovers it", async () => {
	let failReframes = false;
	let failRefreshes = false;
	const fixture = makeFixture("authoritative-blocked-rollback", {
		reframe: async (request, service) => {
			if (failReframes) throw new Error("reframe deliberately failed");
			return service.reframe(request as ServerReframeRequest);
		},
		refresh: async () => {
			if (failRefreshes) throw new Error("refresh deliberately failed");
			return readCapture(fixture.repository, fixture.capture.id!);
		}
	});
	try {
		const message = fixture.capture.messages?.[1];
		assert.ok(message);
		fixture.controller.startSectionAtByte(String(message.id), 0);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);
		const sectionId = String(fixture.capture.frameSections?.[1]?.id);
		const acknowledgedFrameSize = fixture.capture.frameSections?.[0]?.frameSize;
		failReframes = true;
		failRefreshes = true;

		fixture.controller.deleteSection(sectionId);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);

		assert.equal(fixture.capture.frameSections?.length, 1);
		assert.equal(activeSectionRows(fixture).length, 2);
		assert.equal(fixture.controller.isFramingPending(fixture.capture.id!), true);
		assert.equal(fixture.controller.addSequenceNote({ start: 1, end: 1, text: "must stay blocked" }), false);
		fixture.controller.setSectionFrameSize(String(fixture.capture.frameSections?.[0]?.id), 4);
		assert.equal(fixture.capture.frameSections?.[0]?.frameSize, acknowledgedFrameSize);

		failRefreshes = false;
		await fixture.controller.refreshCapture(fixture.capture.id!);
		assert.equal(fixture.controller.isFramingPending(fixture.capture.id!), false);
		assert.equal(fixture.capture.frameSections?.length, 2);

		failReframes = false;
		fixture.controller.deleteSection(sectionId);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);
		assert.equal(activeSectionRows(fixture).length, 1);
	} finally {
		closeFixture(fixture);
	}
});

test("two reframes serialize against the profile acknowledged by the first response", async () => {
	let releaseFirst!: () => void;
	const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
	let firstCall = true;
	let firstResult: Awaited<ReturnType<CanonicalCaptureCommandService["reframe"]>> | undefined;
	const requests: ReframeRequest[] = [];
	const fixture = makeFixture("authoritative-serialized-reframes", {
		reframe: async (request, service) => {
			requests.push(request);
			if (firstCall) {
				firstCall = false;
				await firstGate;
				firstResult = service.reframe(request as ServerReframeRequest);
				return firstResult;
			}
			assert.ok(firstResult);
			assert.equal(request.expectedActiveProfileId, firstResult.profileId);
			return service.reframe(request as ServerReframeRequest);
		}
	});
	try {
		const sectionId = String(fixture.capture.frameSections?.[0]?.id);
		fixture.controller.setSectionFrameSize(sectionId, 1);
		fixture.controller.setSectionFrameSize(sectionId, 4);
		await new Promise<void>(resolve => setImmediate(resolve));
		assert.equal(requests.length, 1);
		releaseFirst();
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);

		assert.equal(requests.length, 2);
		assert.equal(fixture.capture.frameSections?.[0]?.frameSize, 4);
	} finally {
		closeFixture(fixture);
	}
});

test("refresh during a pending reframe keeps acknowledged IDs plus explicit pending intent", async () => {
	let markStarted!: () => void;
	let releaseReframe!: () => void;
	const started = new Promise<void>(resolve => { markStarted = resolve; });
	const gate = new Promise<void>(resolve => { releaseReframe = resolve; });
	const fixture = makeFixture("authoritative-refresh-pending", {
		reframe: async (request, service) => {
			markStarted();
			await gate;
			return service.reframe(request as ServerReframeRequest);
		}
	});
	try {
		const oldProfileId = activeProfileId(fixture);
		const oldFrameIds = (fixture.database
			.prepare("SELECT id FROM materialized_frames WHERE capture_id = @captureId AND profile_id = @profileId ORDER BY ordinal")
			.all({ captureId: fixture.capture.id, profileId: oldProfileId }) as Array<{ id: string }>).map(row => row.id);
		const sectionId = String(fixture.capture.frameSections?.[0]?.id);
		fixture.controller.setSectionFrameSize(sectionId, 1);
		await started;

		await fixture.controller.refreshCapture(fixture.capture.id!);
		assert.equal(fixture.capture.activeFramingProfileId, oldProfileId);
		assert.equal(fixture.capture.frameSections?.[0]?.frameSize, 1);
		assert.deepEqual(
			(fixture.database
				.prepare("SELECT id FROM materialized_frames WHERE capture_id = @captureId AND profile_id = @profileId ORDER BY ordinal")
				.all({ captureId: fixture.capture.id, profileId: oldProfileId }) as Array<{ id: string }>).map(row => row.id),
			oldFrameIds
		);

		releaseReframe();
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);
		assert.notEqual(fixture.capture.activeFramingProfileId, oldProfileId);
		assert.equal(fixture.capture.frameSections?.[0]?.frameSize, 1);
	} finally {
		closeFixture(fixture);
	}
});

test("section view state is synchronous, profile-independent, and survives refresh", async () => {
	const fixture = makeFixture("authoritative-section-view");
	try {
		const profileId = activeProfileId(fixture);
		const frameIds = fixture.capture.messages?.map(message => message.id);
		const sectionId = String(fixture.capture.frameSections?.[0]?.id);
		fixture.controller.setSectionCollapsed(sectionId, true);
		fixture.controller.setSectionCollapse(sectionId, true);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);

		assert.equal(activeProfileId(fixture), profileId);
		assert.deepEqual(fixture.capture.messages?.map(message => message.id), frameIds);
		assert.deepEqual(getSectionViewPreference(fixture.getViewState(), fixture.capture.id, 0), {
			collapseRuns: true,
			collapsed: true
		});
		assert.equal(fixture.capture.frameSections?.[0]?.collapsed, false);
		assert.deepEqual(activeSectionRows(fixture), [{ id: sectionId, start: 0, collapseRuns: 0, collapsed: 0 }]);
		assert.equal(fixture.getSectionViewRequestCount(), 0);

		await fixture.controller.refreshCapture(fixture.capture.id!);
		assert.deepEqual(getSectionViewPreference(fixture.getViewState(), fixture.capture.id, 0), {
			collapseRuns: true,
			collapsed: true
		});
	} finally {
		closeFixture(fixture);
	}
});

test("seeds application view state from legacy persisted section flags", async () => {
	const fixture = makeFixture("authoritative-legacy-section-view");
	try {
		fixture.database
			.prepare(
				`UPDATE framing_sections
				 SET collapse_runs = 1, collapsed = 1
				 WHERE capture_id = @captureId
				   AND profile_id = (SELECT active_framing_profile_id FROM captures WHERE id = @captureId)`
			)
			.run({ captureId: fixture.capture.id });

		await fixture.controller.refreshCapture(fixture.capture.id!);
		assert.deepEqual(getSectionViewPreference(fixture.getViewState(), fixture.capture.id, 0), {
			collapseRuns: true,
			collapsed: true
		});
	} finally {
		closeFixture(fixture);
	}
});

test("moving and deleting sections moves and removes their view preferences", async () => {
	const fixture = makeFixture("authoritative-section-view-lifecycle");
	try {
		const secondMessageId = String(fixture.capture.messages?.[1]?.id);
		fixture.controller.startSectionAtByte(secondMessageId, 0);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);
		let secondSectionId = String(fixture.capture.frameSections?.[1]?.id);
		fixture.controller.setSectionCollapsed(secondSectionId, true);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);
		assert.equal(getSectionViewPreference(fixture.getViewState(), fixture.capture.id, 2)?.collapsed, true);

		fixture.controller.moveSection(secondSectionId, "byte-before");
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);
		assert.equal(getSectionViewPreference(fixture.getViewState(), fixture.capture.id, 2), undefined);
		assert.equal(getSectionViewPreference(fixture.getViewState(), fixture.capture.id, 1)?.collapsed, true);

		secondSectionId = String(fixture.capture.frameSections?.[1]?.id);
		fixture.controller.deleteSection(secondSectionId);
		await fixture.controller.waitForCaptureWrites(fixture.capture.id!);
		assert.equal(getSectionViewPreference(fixture.getViewState(), fixture.capture.id, 1), undefined);
		assert.equal(fixture.getSectionViewRequestCount(), 0);
	} finally {
		closeFixture(fixture);
	}
});
