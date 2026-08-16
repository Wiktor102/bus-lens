import { createExternalStore } from "../../shared/external-store.ts";

export type TransportSnapshot = {
	connected: boolean;
	recording: boolean;
	recordingCaptureId: string | null;
	connectionLabel: "Disconnected" | "Port connected";
	connectLabel: "Connect port" | "Disconnect";
	recordLabel: "Start capture" | "Stop capture";
	recordDisabled: boolean;
};

export type TransportActions = {
	connect: () => Promise<void>;
	disconnect: () => Promise<void>;
	toggleConnection: () => Promise<void>;
	toggleRecording: () => void;
};

export const EMPTY_TRANSPORT_SNAPSHOT: TransportSnapshot = {
	connected: false,
	recording: false,
	recordingCaptureId: null,
	connectionLabel: "Disconnected",
	connectLabel: "Connect port",
	recordLabel: "Start capture",
	recordDisabled: true
};

const noopActions: TransportActions = {
	connect: async () => {},
	disconnect: async () => {},
	toggleConnection: async () => {},
	toggleRecording: () => {}
};

const transportStore = createExternalStore<TransportSnapshot, TransportActions>(
	EMPTY_TRANSPORT_SNAPSHOT,
	noopActions
);

export const getTransportSnapshot = transportStore.getSnapshot;
export const subscribeToTransport = transportStore.subscribe;
export const publishTransportSnapshot = transportStore.publish;
export const registerTransportActions = transportStore.registerActions;
export const getTransportActions = transportStore.getActions;
