import {
	createContext,
	useCallback,
	useContext,
	useSyncExternalStore,
	type PropsWithChildren
} from "react";
import {
	applicationStore,
	type ApplicationEvent,
	type ApplicationSelector,
	type ApplicationState,
	type ApplicationStore
} from "../shared/application-store.ts";

const ApplicationStoreContext = createContext<ApplicationStore>(applicationStore);

export type ApplicationStoreProviderProps = PropsWithChildren<Record<never, never>>;

/** The compatibility bridge and controller share this singleton, so there is no alternate store seam here. */
export function ApplicationStoreProvider({ children }: ApplicationStoreProviderProps) {
	return <ApplicationStoreContext.Provider value={applicationStore}>{children}</ApplicationStoreContext.Provider>;
}

export function useApplicationStore(): ApplicationStore {
	return useContext(ApplicationStoreContext);
}

export function useApplicationSelector<Selected>(selector: ApplicationSelector<Selected>): Selected {
	const store = useApplicationStore();
	const getSelected = useCallback(() => store.select(selector), [store, selector]);
	return useSyncExternalStore(store.subscribe, getSelected, getSelected);
}

export function useApplicationSend(): (event: ApplicationEvent) => void {
	const store = useApplicationStore();
	return useCallback((event: ApplicationEvent) => store.send(event), [store]);
}

export type { ApplicationEvent, ApplicationSelector, ApplicationState, ApplicationStore };
