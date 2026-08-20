import assert from "node:assert/strict";
import test from "node:test";
import { createCaptureController } from "../src/features/capture/capture-controller.ts";
import { rebuildPreview, type Capture } from "../src/features/capture/capture-framing.ts";
import { createLiveStateService } from "../src/app/live-state-service.ts";
import { deriveMessageStreamSnapshot, type MessageStreamSnapshot } from "../src/features/message-stream/message-stream.ts";
import { createApplicationStore, selectViewState } from "../src/shared/application-store.ts";
import { getSectionViewPreference } from "../src/shared/view-state.ts";
import type { CaptureWriter } from "../src/persistence/archive-client.ts";

function idFactory(prefix: string) {
	let count = 0;
	return () => `${prefix}-${++count}`;
}

type Fixture = {
	capture: Capture;
	controller: ReturnType<typeof createCaptureController>;
	getDerivationCount: () => number;
	getRenderOptions: () => Array<{ skipMessageStream?: boolean } | undefined>;
	resetCounts: () => void;
	close: () => void;
};

function makeFixture(authoritativeDifference = false): Fixture {
	const store = createApplicationStore();
	const capture = {
		id: "section-render-capture",
		activeFramingProfileId: "profile-1",
		contentRevision: 1,
		frameSize: 2,
		byteStream: Array.from({ length: 8 }, (_, rawOffset) => ({
			value: rawOffset + 1,
			timestamp: rawOffset,
			rawOffset
		})),
		messages: [],
		notes: [],
		annotations: {},
		frameSections: [{ id: "section-1", start: 0, frameSize: 2 }]
	} as Capture;
	rebuildPreview(capture, idFactory("message"));

	let derivationCount = 0;
	const renderOptions: Array<{ skipMessageStream?: boolean } | undefined> = [];
	const transport = {
		getPort: () => null,
		isRecording: () => false,
		getRecordingCaptureId: () => null,
		publishState: () => {},
		isCaptureMutationLocked: () => false,
		isCaptureFinalizing: () => false,
		stopRecording: async () => {}
	};
	const snapshots = createLiveStateService({
		capture: () => capture,
		getTransport: () => transport,
		getSendController: () => undefined,
		applicationStore: store,
		deriveMessageStreamSnapshot: (
			current: Parameters<typeof deriveMessageStreamSnapshot>[0],
			viewState: Parameters<typeof deriveMessageStreamSnapshot>[1],
			options?: Parameters<typeof deriveMessageStreamSnapshot>[2]
		): MessageStreamSnapshot => {
			derivationCount += 1;
			return deriveMessageStreamSnapshot(current, viewState, options);
		}
	});
	const unsubscribe = snapshots.subscribeToViewStateChanges();

	function sendViewEvent(send: () => void): boolean {
		const previous = store.select(selectViewState);
		send();
		const next = store.select(selectViewState);
		if (next === previous) return false;
		const sections = capture.frameSections?.length
			? capture.frameSections
			: [{ start: 0, collapseRuns: false, collapsed: false }];
		return sections.some(section => {
			const rawStart = Number(section.start ?? 0);
			const previousPreference = getSectionViewPreference(previous, String(capture.id ?? ""), rawStart);
			const nextPreference = getSectionViewPreference(next, String(capture.id ?? ""), rawStart);
			return (
				previousPreference?.collapseRuns !== nextPreference?.collapseRuns ||
				previousPreference?.collapsed !== nextPreference?.collapsed
			);
		});
	}

	let reframeCount = 0;
	const writer = {
		reframe: async () => {
			reframeCount += 1;
			return { profileId: String(capture.activeFramingProfileId) };
		}
	} as unknown as CaptureWriter;
	const controller = createCaptureController({
		capture: () => capture,
		getCapture: () => capture,
		getActiveId: () => String(capture.id),
		setActiveId: () => {},
		setActiveCapture: next => {
			if (next) Object.assign(capture, next);
		},
		render: options => {
			renderOptions.push(options);
			snapshots.render(options);
		},
		renderMessages: snapshots.renderMessages,
		showToast: () => {},
		transport,
		publishDialogCommand: () => {},
		captureWriter: writer,
		isCanonicalCapture: () => true,
		refreshCapture: async () => {
			const refreshed = structuredClone(capture);
			if (authoritativeDifference && reframeCount > 0 && refreshed.messages?.[0]) {
				refreshed.messages[0].id = "authoritative-message";
				refreshed.contentRevision = 2;
			}
			return refreshed;
		},
		seedSectionViewState: (captureId, sections) => sendViewEvent(() => store.send({
			type: "view/section-preferences-seeded",
			captureId,
			sections
		})),
		getSectionViewPreference: (captureId, rawStart) =>
			getSectionViewPreference(store.select(selectViewState), captureId, rawStart),
		setSectionViewState: (captureId, rawStart, patch) => store.send({
			type: "view/section-preference-changed",
			captureId,
			rawStart,
			patch
		}),
		copySectionViewState: (captureId, fromRawStart, toRawStart) => sendViewEvent(() => store.send({
			type: "view/section-preference-copied",
			captureId,
			fromRawStart,
			toRawStart
		})),
		reconcileSectionViewState: (captureId, rawStarts) => sendViewEvent(() => store.send({
			type: "view/section-preferences-reconciled",
			captureId,
			rawStarts
		})),
		clearSectionViewState: captureId => store.send({ type: "view/section-preferences-cleared", captureId })
	});

	snapshots.render();
	controller.seedSectionViewPreferences();
	derivationCount = 0;
	renderOptions.length = 0;

	return {
		capture,
		controller,
		getDerivationCount: () => derivationCount,
		getRenderOptions: () => renderOptions,
		resetCounts: () => {
			derivationCount = 0;
			renderOptions.length = 0;
		},
		close: unsubscribe
	};
}

test("section commands derive one optimistic stream projection and coordinator status renders skip it", async () => {
	const fixture = makeFixture();
	try {
		const firstSectionId = String(fixture.capture.frameSections?.[0]?.id);
		fixture.controller.setSectionFrameSize(firstSectionId, 3);
		await fixture.controller.waitForCaptureWrites(String(fixture.capture.id));
		assert.equal(fixture.getDerivationCount(), 1);
		assert.equal(fixture.getRenderOptions().filter(options => options?.skipMessageStream).length, 3);

		fixture.resetCounts();
		const messageForNewSection = fixture.capture.messages?.[1];
		assert.ok(messageForNewSection);
		fixture.controller.startSectionAtByte(String(messageForNewSection.id), 0);
		await fixture.controller.waitForCaptureWrites(String(fixture.capture.id));
		assert.equal(fixture.getDerivationCount(), 1);

		fixture.resetCounts();
		const createdSectionId = String(fixture.capture.frameSections?.[1]?.id);
		fixture.controller.moveSection(createdSectionId, "byte-before");
		await fixture.controller.waitForCaptureWrites(String(fixture.capture.id));
		assert.equal(fixture.getDerivationCount(), 1);

		fixture.resetCounts();
		const movedSectionId = String(fixture.capture.frameSections?.[1]?.id);
		fixture.controller.deleteSection(movedSectionId);
		await fixture.controller.waitForCaptureWrites(String(fixture.capture.id));
		assert.equal(fixture.getDerivationCount(), 1);
	} finally {
		fixture.close();
	}
});

test("authoritative framing refresh derives once more only when its projection differs", async () => {
	const fixture = makeFixture(true);
	try {
		const sectionId = String(fixture.capture.frameSections?.[0]?.id);
		fixture.controller.setSectionFrameSize(sectionId, 4);
		await fixture.controller.waitForCaptureWrites(String(fixture.capture.id));
		assert.equal(fixture.getDerivationCount(), 2);
	} finally {
		fixture.close();
	}
});
