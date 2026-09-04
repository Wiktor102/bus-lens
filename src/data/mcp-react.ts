import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getMcpStatus, setMcpAgentNotes, setMcpProject } from "../app/mcp-access.ts";
import { createMcpMutationOptions, createMcpQueryOptions, mcpMutationKeys, type McpQuerySource } from "./mcp-queries.ts";

const source: McpQuerySource = {
	getStatus: getMcpStatus,
	setProject: setMcpProject,
	setAgentNotes: setMcpAgentNotes
};

const queries = createMcpQueryOptions(source);

export function useMcpStatus() {
	return useQuery(queries.status());
}

export function useSetMcpProject() {
	const queryClient = useQueryClient();
	return useMutation(createMcpMutationOptions(source, queryClient).project());
}

export function useSetMcpAgentNotes() {
	const queryClient = useQueryClient();
	return useMutation(createMcpMutationOptions(source, queryClient).notes());
}

export function useMcpProjectMutationPending(): boolean {
	return useIsMutating({ mutationKey: mcpMutationKeys.project() }) > 0;
}
