export type BeforeUnloadDependencies = {
	beginUnload: () => void;
	flushLiveBytes: () => void;
	getPort: () => unknown;
	disconnect: (options?: { persist?: boolean }) => Promise<void> | void;
	hasUnacknowledgedBytes?: () => boolean;
};

export type BeforeUnloadEventLike = {
	preventDefault: () => void;
	returnValue?: string;
};

export function createBeforeUnloadHandler(dependencies: BeforeUnloadDependencies): (event?: BeforeUnloadEventLike) => void {
	return event => {
		dependencies.beginUnload();
		dependencies.flushLiveBytes();
		if (dependencies.hasUnacknowledgedBytes?.() && event) {
			event.preventDefault();
			event.returnValue = "";
		}
		if (dependencies.getPort()) void dependencies.disconnect({ persist: false });
	};
}
