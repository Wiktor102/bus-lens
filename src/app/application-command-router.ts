import type { ApplicationCommand, ApplicationStore } from "../shared/application-store.ts";
import { EMPTY_PERSISTENCE_ERROR, getPersistenceErrorSnapshot, publishPersistenceError } from "../shared/persistence-error-bridge.ts";
import type { CaptureController } from "../features/capture/capture-controller.ts";
import type { DataTransferController } from "../features/data-transfer/data-transfer.ts";
import type { MessageStreamActions } from "../features/message-stream/message-stream-bridge.ts";
import type { SendController } from "../features/send/send-controller.ts";
import type { SerialController } from "../features/transport/serial-controller.ts";
import { download } from "../features/data-transfer/browser-download.ts";

export type ApplicationCommandRouterDependencies = {
	store: Pick<ApplicationStore, "subscribeToCommands">;
	transport: SerialController;
	sendController: SendController;
	captureController: CaptureController;
	dataTransferController: DataTransferController;
	messageActions: MessageStreamActions;
	showToast: (message: string) => void;
	openExportDialog: () => void;
	closeCanonicalizationDialog: () => void;
	downloadLegacyBackup: () => Promise<void>;
	startCanonicalization: () => Promise<void>;
	retryCanonicalization: () => Promise<void>;
	retrySendPersistence: () => void;
};

/**
 * Routes typed application commands to focused workflow services. The router
 * owns composition only; it does not own server data or client state.
 */
export function subscribeToApplicationCommands(dependencies: ApplicationCommandRouterDependencies): () => void {
	return dependencies.store.subscribeToCommands((command: ApplicationCommand) => {
		switch (command.type) {
			case "transport/connect":
				void dependencies.transport.connect();
				break;
			case "transport/disconnect":
				void dependencies.transport.disconnect();
				break;
			case "transport/toggle-connection":
				void dependencies.transport.toggleConnection();
				break;
			case "recording/toggle":
				void dependencies.transport.toggleRecording();
				break;
			case "capture/set-title":
				dependencies.captureController.setCaptureTitle(command.value);
				break;
			case "capture/commit-title":
				dependencies.captureController.commitCaptureTitle(command.value);
				break;
			case "capture/set-description":
				dependencies.captureController.setCaptureDescription(command.value);
				break;
			case "capture/commit-description":
				dependencies.captureController.commitCaptureDescription(command.value);
				break;
			case "capture/open-context":
				dependencies.captureController.publishContextDialog();
				break;
			case "capture/duplicate":
				dependencies.captureController.duplicateActiveCapture();
				break;
			case "capture/clear-messages":
				dependencies.captureController.clearActiveCaptureMessages();
				break;
			case "capture/delete-active":
				void dependencies.captureController.deleteActiveCapture();
				break;
			case "capture/upgrade-active":
				dependencies.captureController.upgradeActiveCapture();
				break;
			case "capture/upgrade":
				dependencies.captureController.upgradeCapture(command.captureId);
				break;
			case "capture/delete":
				void dependencies.captureController.deleteArchiveCapture(command.captureId);
				break;
			case "archive/select":
				dependencies.captureController.selectArchiveCapture(command.captureId);
				break;
			case "archive/toggle-folder":
				dependencies.captureController.toggleArchiveFolder(command.folderId);
				break;
			case "archive/move-capture":
				dependencies.captureController.moveArchiveCapture(command.captureId, command.folderId);
				break;
			case "archive/open-new-capture":
				dependencies.captureController.publishContextDialog(true);
				break;
			case "archive/open-export":
				dependencies.openExportDialog();
				break;
			case "archive/save-folder":
				dependencies.captureController.saveFolder(command.name, command.editingId);
				break;
			case "archive/delete-folder":
				dependencies.captureController.deleteFolder(command.folderId);
				break;
			case "archive/import-file":
				void dependencies.dataTransferController.importFile(command.file);
				break;
			case "storage/upgrade":
				dependencies.captureController.upgradeActiveCapture();
				break;
			case "dialog/save-context":
				dependencies.captureController.commitContextDraft(command.input);
				break;
			case "dialog/save-annotation":
				dependencies.captureController.commitAnnotationDraft(command.input);
				break;
			case "dialog/delete-annotation":
				dependencies.captureController.removeAnnotationDraft(command.input);
				break;
			case "dialog/save-pattern-remark":
				dependencies.captureController.commitPatternRemarkDraft(command.input);
				break;
			case "dialog/export":
				void dependencies.dataTransferController.exportData(command.format);
				break;
			case "dialog/notify":
				dependencies.showToast(command.message);
				break;
			case "canonicalization/close":
				dependencies.closeCanonicalizationDialog();
				break;
			case "canonicalization/download":
				void dependencies.downloadLegacyBackup();
				break;
			case "canonicalization/start":
				void dependencies.startCanonicalization();
				break;
			case "canonicalization/retry":
				void dependencies.retryCanonicalization();
				break;
			case "send/set-draft":
				dependencies.sendController.setSendDraft(command.value);
				break;
			case "send/set-delay":
				dependencies.sendController.setQueueDelay(command.value);
				break;
			case "send/send":
				void dependencies.sendController.sendBytes(command.bytes).then(command.respond);
				break;
			case "send/add-to-queue":
				dependencies.sendController.addDraftToQueue(command.bytes);
				break;
			case "send/send-queue-item":
				dependencies.sendController.sendQueueItem(command.id);
				break;
			case "send/remove-queue-item":
				dependencies.sendController.removeQueueItem(command.id);
				break;
			case "send/replay-history":
				dependencies.sendController.replayHistoryItem(command.id);
				break;
			case "send/run-queue":
				void dependencies.sendController.runSendQueue();
				break;
			case "send/stop-queue":
				dependencies.sendController.stopSendQueue();
				break;
			case "send/clear-queue":
				dependencies.sendController.clearSendQueue();
				break;
			case "send/clear-history":
				dependencies.sendController.clearSendHistory();
				break;
			case "message/open-note":
				dependencies.messageActions.openMessageNote(command.messageId);
				break;
			case "message/open-byte-note":
				dependencies.messageActions.openByteNote(command.messageId, command.position);
				break;
			case "message/replay":
				dependencies.messageActions.replayMessage(command.messageId);
				break;
			case "message/open-pattern-remark":
				dependencies.messageActions.openPatternRemark(command.patternId);
				break;
			case "message/hide":
				dependencies.messageActions.hideMessage(command.messageId);
				break;
			case "message/hide-byte":
				dependencies.messageActions.hideByte(command.messageId, command.position);
				break;
			case "message/begin-section":
				dependencies.messageActions.beginSection(command.messageId, command.position);
				break;
			case "message/move-section":
				dependencies.messageActions.moveSection(command.sectionId, command.action);
				break;
			case "message/delete-section":
				dependencies.messageActions.deleteSection(command.sectionId);
				break;
			case "message/set-section-framing":
				dependencies.messageActions.setSectionFraming(command.sectionId, command.update);
				break;
			case "message/set-section-frame-size":
				dependencies.messageActions.setSectionFrameSize(command.sectionId, command.value);
				break;
			case "message/set-section-framing-mode":
				dependencies.messageActions.setSectionFramingMode(command.sectionId, command.value);
				break;
			case "message/set-section-frame-marker":
				dependencies.messageActions.setSectionFrameMarker(command.sectionId, command.value);
				break;
			case "message/set-section-marker-position":
				dependencies.messageActions.setSectionMarkerPosition(command.sectionId, command.value);
				break;
			case "message/set-section-frame-time-gap":
				dependencies.messageActions.setSectionFrameTimeGap(command.sectionId, command.value);
				break;
			case "message/set-section-collapse":
				dependencies.messageActions.setSectionCollapse(command.sectionId, command.collapseRuns);
				break;
			case "message/set-section-collapsed":
				dependencies.messageActions.setSectionCollapsed(command.sectionId, command.collapsed);
				break;
			case "notes/add-sequence":
				dependencies.captureController.addSequenceNote(command);
				break;
			case "persistence/retry":
				if (getPersistenceErrorSnapshot().captureId === null) dependencies.retrySendPersistence();
				else void dependencies.transport.retryPersistence();
				break;
			case "persistence/export-recovery": {
				const capture = dependencies.transport.recoveryDocument();
				if (capture) download(
					JSON.stringify(capture, null, 2),
					`bus-lens-${String(capture.id ?? "capture")}-recovery.json`,
					"application/json"
				);
				break;
			}
			case "persistence/dismiss":
				publishPersistenceError(EMPTY_PERSISTENCE_ERROR);
				break;
		}
	});
}
