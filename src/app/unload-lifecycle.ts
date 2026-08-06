export type BeforeUnloadDependencies = {
	beginUnload: () => void;
	flushLiveBytes: () => void;
	getPort: () => unknown;
	disconnect: (options?: { persist?: boolean }) => Promise<void> | void;
};

export function createBeforeUnloadHandler(dependencies: BeforeUnloadDependencies): () => void {
	return () => {
		dependencies.beginUnload();
		dependencies.flushLiveBytes();
		if (dependencies.getPort()) void dependencies.disconnect({ persist: false });
	};
}
