import { applicationStore } from "../../shared/application-store.ts";

/** Typed command actions for transport controls. */
export type TransportActions = {
	connect: () => Promise<void>;
	disconnect: () => Promise<void>;
	toggleConnection: () => Promise<void>;
	toggleRecording: () => void;
};

const actions: TransportActions = {
	connect: async () => { applicationStore.sendCommand({ type: "transport/connect" }); },
	disconnect: async () => { applicationStore.sendCommand({ type: "transport/disconnect" }); },
	toggleConnection: async () => { applicationStore.sendCommand({ type: "transport/toggle-connection" }); },
	toggleRecording: () => applicationStore.sendCommand({ type: "recording/toggle" })
};

export const getTransportActions = (): TransportActions => actions;
