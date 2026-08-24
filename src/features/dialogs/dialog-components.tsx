import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function DialogHeading({
	eyebrow,
	title,
	titleId,
	className,
	leading,
	onClose
}: {
	eyebrow?: string;
	title: string;
	titleId?: string;
	className?: string;
	leading?: ReactNode;
	onClose?: () => void;
}) {
	return (
		<div className={`modal-heading ${className || ""}`.trim()}>
			{leading}
			<div className="modal-heading-copy">
				{eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
				<h2 id={titleId}>{title}</h2>
			</div>
			<button
				className="icon-btn"
				type={onClose ? "button" : undefined}
				value={onClose ? undefined : "cancel"}
				formMethod={onClose ? undefined : "dialog"}
				formNoValidate={onClose ? undefined : true}
				aria-label="Close"
				onClick={onClose ? () => onClose() : undefined}
			>
				<X aria-hidden="true" />
			</button>
		</div>
	);
}

export function ManagedDialog({
	id,
	className,
	open,
	eyebrow,
	title,
	onClose,
	children,
	actions
}: {
	id: string;
	className?: string;
	open: boolean;
	eyebrow: string;
	title: string;
	onClose: () => void;
	children: ReactNode;
	actions?: ReactNode;
}) {
	const dialogRef = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	}, [open]);

	return (
		<dialog
			id={id}
			className={`modal managed-modal ${className || ""}`.trim()}
			ref={dialogRef}
			onCancel={event => {
				event.preventDefault();
				onClose();
			}}
		>
			<div className="managed-modal-content">
				<DialogHeading eyebrow={eyebrow} title={title} onClose={onClose} />
				{children}
				{actions ? <div className="modal-actions">{actions}</div> : null}
			</div>
		</dialog>
	);
}
