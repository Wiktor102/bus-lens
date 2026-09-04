import type { ReactNode } from "react";

type StatusSplitControlProps = {
	status: ReactNode;
	connected: boolean;
	tone?: "default" | "warning";
	statusId?: string;
	statusAction?: Readonly<{ label: string; onClick: () => void; disabled?: boolean }>;
	action: ReactNode;
};

export function StatusSplitControl({ status, connected, tone = "default", statusId, statusAction, action }: StatusSplitControlProps) {
	const content = <><i aria-hidden="true" /> {status}</>;
	return (
		<div className={`status-split-control ${connected ? "connected" : ""} ${tone === "warning" ? "warning" : ""}`.trim()}>
			{statusAction ? (
				<button id={statusId} className="status-split-value status-split-value-action" type="button" aria-label={statusAction.label} disabled={statusAction.disabled} onClick={() => statusAction.onClick()}>{content}</button>
			) : (
				<span id={statusId} className="status-split-value" role="status" aria-live="polite">{content}</span>
			)}
			{action}
		</div>
	);
}
