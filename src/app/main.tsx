import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { createAppQueryClient } from "../data/query-client";
import App from "./App";
import { ApplicationStoreProvider } from "./application-store-provider";

const root = document.getElementById("root");

if (!root) {
	throw new Error("Bus Lens root element was not found");
}

const queryClient = createAppQueryClient();

createRoot(root).render(
	<QueryClientProvider client={queryClient}>
		<ApplicationStoreProvider>
			<App />
		</ApplicationStoreProvider>
	</QueryClientProvider>
);
