import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createAppQueryClient } from "../data/query-client";
import { createArchiveDataLayer } from "../data/archive-data-layer";
import { ArchiveDataProvider } from "../data/archive-react";
import { ArchiveClient } from "../persistence/archive-client";
import App from "./App";
import { ApplicationStoreProvider } from "./application-store-provider";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Bus Lens root element was not found");
}

const queryClient = createAppQueryClient();
const archive = createArchiveDataLayer(queryClient, new ArchiveClient());

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<ArchiveDataProvider layer={archive}>
			<ApplicationStoreProvider>
				<App />
			</ApplicationStoreProvider>
		</ArchiveDataProvider>
	</QueryClientProvider>
);
