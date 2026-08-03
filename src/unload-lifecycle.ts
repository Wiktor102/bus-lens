export type BeforeUnloadDependencies = {
	flushLiveBytes: () => void;
	persistState: () => void;
	getPort: () => unknown;
	disconnect: () => Promise<void> | void;
};

export function createBeforeUnloadHandler(dependencies: BeforeUnloadDependencies): () => void {
	return () => {
		dependencies.flushLiveBytes();
		dependencies.persistState();
		if (dependencies.getPort()) void dependencies.disconnect();
	};
}
