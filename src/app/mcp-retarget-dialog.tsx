import { useEffect, useRef } from "react";
import { AlertTriangle, X } from "lucide-react";
import { formatMcpActivity, type AgentAccessStatus } from "./mcp-access";

export function McpRetargetDialog({
	status,
	targetName,
	busy,
	onCancel,
	onConfirm
}: {
	status: AgentAccessStatus | null;
	targetName: string;
	busy: boolean;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const dialog = ref.current;
		if (!dialog) return;
		if (!status) {
			if (dialog.open) dialog.close();
			return;
		}
		if (!dialog.open) dialog.showModal();
		const frame = requestAnimationFrame(() => cancelRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [status]);

	return (
		<dialog
			className="modal confirmation-modal mcp-retarget-modal"
			ref={ref}
			role="alertdialog"
			aria-labelledby="mcpRetargetTitle"
			aria-describedby="mcpRetargetDetail"
			onCancel={event => {
				event.preventDefault();
				onCancel();
			}}
		>
			<div className="modal-heading confirmation-heading">
				<span className="confirmation-signal" aria-hidden="true"><AlertTriangle /></span>
				<div>
					<span className="eyebrow">MCP in use</span>
					<h2 id="mcpRetargetTitle">Move MCP to {targetName}?</h2>
				</div>
				<button className="icon-btn" type="button" aria-label="Close" disabled={busy} onClick={() => onCancel()}><X aria-hidden="true" /></button>
			</div>
			<p id="mcpRetargetDetail" className="modal-lede">
				{status ? formatMcpActivity(status) : ""} Moving it will disconnect agents from {status?.project.name ?? "the current project"}.
			</p>
			<div className="modal-actions">
				<button ref={cancelRef} className="btn btn-secondary" type="button" disabled={busy} onClick={() => onCancel()}>Keep current project</button>
				<button className="btn btn-warning" type="button" disabled={busy} onClick={() => onConfirm()}>{busy ? "Moving…" : "Move MCP"}</button>
			</div>
		</dialog>
	);
}
