import type { ReactNode } from "react";

type StatusSplitControlProps = {
	status: ReactNode;
	connected: boolean;
	statusId?: string;
	action: ReactNode;
};

export function StatusSplitControl({ status, connected, statusId, action }: StatusSplitControlProps) {
	return (
		<div className={`status-split-control ${connected ? "connected" : ""}`.trim()}>
			<span id={statusId} className="status-split-value" role="status" aria-live="polite">
				<i aria-hidden="true" /> {status}
			</span>
			{action}
		</div>
	);
}
