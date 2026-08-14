/**
 * Compatibility action registry for the transport controls.
 *
 * Transport state is owned by the application store; this module no longer
 * publishes or stores a transport snapshot.
 */
export type TransportActions = {
	connect: () => Promise<void>;
	disconnect: () => Promise<void>;
	toggleConnection: () => Promise<void>;
	toggleRecording: () => void;
};

const noopActions: TransportActions = {
	connect: async () => {},
	disconnect: async () => {},
	toggleConnection: async () => {},
	toggleRecording: () => {}
};

let actions: TransportActions = noopActions;

export const registerTransportActions = (next: TransportActions): void => {
	actions = next;
};
export const getTransportActions = (): TransportActions => actions;
