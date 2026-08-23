import { createRoot } from "react-dom/client";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { createAppQueryClient } from "../data/query-client";
import { createArchiveDataLayer } from "../data/archive-data-layer";
import { ArchiveDataProvider } from "../data/archive-react";
import { createTabProjectSelection } from "../persistence/active-project";
import { ArchiveClient } from "../persistence/archive-client";
import App from "./App";
import { ApplicationStoreProvider } from "./application-store-provider";

focusManager.setEventListener(onFocus => {
	const notifyFocus = () => onFocus();
	window.addEventListener("focus", notifyFocus);
	window.addEventListener("visibilitychange", notifyFocus);
	return () => {
		window.removeEventListener("focus", notifyFocus);
		window.removeEventListener("visibilitychange", notifyFocus);
	};
});

const root = document.getElementById("root");

if (!root) {
	throw new Error("Bus Lens root element was not found");
}

const queryClient = createAppQueryClient();
const projectSelection = createTabProjectSelection(globalThis.sessionStorage, globalThis.localStorage);
const archive = createArchiveDataLayer(
	queryClient,
	new ArchiveClient({ getActiveProjectId: () => projectSelection.projectId }),
	undefined,
	{ activeProjectStorage: projectSelection.storage }
);

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<ArchiveDataProvider layer={archive}>
			<ApplicationStoreProvider>
				<App />
			</ApplicationStoreProvider>
		</ArchiveDataProvider>
	</QueryClientProvider>
);
