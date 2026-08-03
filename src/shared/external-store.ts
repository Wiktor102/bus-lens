export type ExternalStore<Snapshot, Actions> = {
	getSnapshot: () => Snapshot;
	subscribe: (listener: () => void) => () => void;
	publish: (snapshot: Snapshot) => void;
	registerActions: (actions: Actions) => void;
	getActions: () => Actions;
};

export function createExternalStore<Snapshot, Actions>(
	initialSnapshot: Snapshot,
	initialActions: Actions
): ExternalStore<Snapshot, Actions> {
	let snapshot = initialSnapshot;
	let actions = initialActions;
	const listeners = new Set<() => void>();

	return {
		getSnapshot: () => snapshot,
		subscribe: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		publish: nextSnapshot => {
			snapshot = nextSnapshot;
			listeners.forEach(listener => listener());
		},
		registerActions: nextActions => {
			actions = nextActions;
		},
		getActions: () => actions
	};
}
