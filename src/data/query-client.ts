import { QueryClient } from "@tanstack/react-query";

/**
 * The application QueryClient is created at the UI boundary so all server-owned
 * data has one cache for the lifetime of the application.
 */
export function createAppQueryClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: {
				staleTime: 30_000,
				refetchOnWindowFocus: false
			},
			mutations: {
				retry: false
			}
		}
	});
}
