import { mutationOptions, queryOptions, type QueryClient } from "@tanstack/react-query";
import { McpRecentlyUsedError, type AgentAccessStatus } from "../app/mcp-access.ts";

const mcpRoot = ["mcp"] as const;

export const mcpQueryKeys = {
	all: mcpRoot,
	status: () => [...mcpRoot, "status"] as const
};

export const mcpMutationKeys = {
	all: [...mcpRoot, "mutation"] as const,
	project: () => [...mcpMutationKeys.all, "project"] as const,
	notes: () => [...mcpMutationKeys.all, "notes"] as const
};

export type McpQuerySource = Readonly<{
	getStatus: () => Promise<AgentAccessStatus>;
	setProject: (projectId: string, force?: boolean) => Promise<AgentAccessStatus>;
	setAgentNotes: (projectId: string, enabled: boolean) => Promise<void>;
}>;

export type SetMcpProjectCommand = Readonly<{
	projectId: string;
	force?: boolean;
}>;

export type SetMcpAgentNotesCommand = Readonly<{
	projectId: string;
	enabled: boolean;
}>;

export function createMcpQueryOptions(source: Pick<McpQuerySource, "getStatus">) {
	return {
		status: () => queryOptions({
			queryKey: mcpQueryKeys.status(),
			queryFn: () => source.getStatus(),
			retry: false,
			staleTime: 0,
			refetchOnWindowFocus: "always" as const
		})
	};
}

export function createMcpMutationOptions(source: McpQuerySource, queryClient: QueryClient) {
	return {
		project: () => mutationOptions({
			mutationKey: mcpMutationKeys.project(),
			mutationFn: (command: SetMcpProjectCommand) => source.setProject(command.projectId, command.force),
			onMutate: () => queryClient.cancelQueries({ queryKey: mcpQueryKeys.status() }),
			onSuccess: status => {
				queryClient.setQueryData(mcpQueryKeys.status(), status);
			},
			onError: (error: unknown) => {
				if (error instanceof McpRecentlyUsedError) {
					queryClient.setQueryData(mcpQueryKeys.status(), error.status);
					return;
				}
				void queryClient.invalidateQueries({ queryKey: mcpQueryKeys.status() });
			}
		}),
		notes: () => mutationOptions({
			mutationKey: mcpMutationKeys.notes(),
			mutationFn: (command: SetMcpAgentNotesCommand) => source.setAgentNotes(command.projectId, command.enabled),
			onSettled: () => queryClient.invalidateQueries({ queryKey: mcpQueryKeys.status() })
		})
	};
}
