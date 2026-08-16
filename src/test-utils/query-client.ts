import { QueryClient } from "@tanstack/react-query";

/** Create an isolated cache for a test; no state is shared between tests. */
export function createTestQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
				gcTime: 0
			},
			mutations: {
				retry: false
			}
		}
	});
}
