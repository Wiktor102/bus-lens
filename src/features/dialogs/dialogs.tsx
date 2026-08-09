import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type CSSProperties } from "react";
import { getDialogActions, getDialogSnapshot, subscribeToDialogs } from "./dialog-bridge";
import {
	appendContextParameter,
	annotationTextIsValid,
	createContextDraft,
	normalizeAnnotationText,
	normalizePatternRemarkText,
	removeContextParameter,
	updateContextParameter,
	type ContextDialogDraft,
	type ExportFormat
} from "./dialog-model";

function isCancelSubmit(event: FormEvent<HTMLFormElement>): boolean {
	return ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === "cancel";
}

function useDialogCommand() {
	return useSyncExternalStore(subscribeToDialogs, getDialogSnapshot, getDialogSnapshot).command;
}

function DialogHeading({ eyebrow, title }: { eyebrow: string; title: string }) {
	return (
		<div className="modal-heading">
			<div>
				<span className="eyebrow">{eyebrow}</span>
				<h2>{title}</h2>
			</div>
			<button className="icon-btn" value="cancel" formMethod="dialog" formNoValidate aria-label="Close">
				×
			</button>
		</div>
	);
}

export function ContextDialog() {
	const command = useDialogCommand();
	const contextCommand = command?.type === "context" ? command : null;
	const actions = getDialogActions();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const nameRef = useRef<HTMLInputElement>(null);
	const [draft, setDraft] = useState<ContextDialogDraft | null>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (!contextCommand) {
			if (dialog.open) dialog.close();
			setDraft(null);
			return;
		}
		setDraft(createContextDraft(contextCommand));
		if (!dialog.open) dialog.showModal();
		const frame = requestAnimationFrame(() => nameRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [contextCommand]);

	const updateDraft = (update: Partial<ContextDialogDraft>) =>
		setDraft(current => (current ? { ...current, ...update } : current));

	return (
		<dialog
			id="contextDialog"
			className="modal"
			data-mode={contextCommand?.mode}
			ref={dialogRef}
			onClose={() => setDraft(null)}
		>
			<form
				id="contextForm"
				method="dialog"
				onSubmit={event => {
					if (isCancelSubmit(event)) return;
					event.preventDefault();
					if (!contextCommand || !draft) return;
					if (
						actions.saveContext({
							mode: contextCommand.mode,
							captureId: contextCommand.captureId,
							draft
						})
					)
						dialogRef.current?.close();
				}}
			>
				<DialogHeading eyebrow="Capture definition" title="Controller context" />
				<label className="field">
					Capture name
					<input
						id="contextName"
						ref={nameRef}
						required
						value={draft?.name || ""}
						onChange={event => updateDraft({ name: event.currentTarget.value })}
					/>
				</label>
				<label className="field">
					Controller screen / view
					<input
						id="contextView"
						placeholder="e.g. Temperature"
						value={draft?.view || ""}
						onChange={event => updateDraft({ view: event.currentTarget.value })}
					/>
				</label>
				<label className="field">
					Archive folder
					<select
						id="contextFolder"
						value={draft?.folderId || ""}
						onChange={event => updateDraft({ folderId: event.currentTarget.value })}
					>
						<option value="">Unfiled</option>
						{contextCommand?.folders.map(folder => (
							<option key={folder.id} value={folder.id}>
								{folder.name}
							</option>
						))}
					</select>
				</label>
				<div className="field">
					<div className="field-row">
						<span>Parameters</span>
						<button
							id="addParameterBtn"
							type="button"
							className="text-btn"
							onClick={() => setDraft(current => (current ? { ...current, parameters: appendContextParameter(current.parameters) } : current))}
						>
							＋ Add parameter
						</button>
					</div>
					<div id="parameterRows" className="parameter-rows">
						{draft?.parameters.map(parameter => (
							<div className="parameter-row" key={parameter.id}>
								<input
									placeholder="Parameter"
									value={parameter.key}
									onChange={event => {
										const key = event.currentTarget.value;
										setDraft(current =>
											current
												? {
														...current,
														parameters: updateContextParameter(current.parameters, parameter.id, { key })
													}
												: current
											)
									}}
								/>
								<input
									placeholder="Value"
									value={parameter.value}
									onChange={event => {
										const value = event.currentTarget.value;
										setDraft(current =>
											current
												? {
														...current,
														parameters: updateContextParameter(current.parameters, parameter.id, { value })
													}
												: current
											)
									}}
								/>
								<button
									type="button"
									aria-label="Remove"
									onClick={() =>
										setDraft(current =>
											current
												? {
														...current,
														parameters: removeContextParameter(current.parameters, parameter.id)
													}
												: current
											)
									}
								>
									×
								</button>
							</div>
						))}
					</div>
				</div>
				<div className="serial-settings">
					<label className="field">
						Baud rate
						<select
							id="baudRate"
							value={draft?.baudRate || "115200"}
							onChange={event => updateDraft({ baudRate: event.currentTarget.value })}
						>
							<option>9600</option>
							<option>19200</option>
							<option>115200</option>
							<option>250000</option>
						</select>
					</label>
					<div className="field serial-format">
						<span>Input format</span>
						<strong>Raw binary bytes</strong>
						<small>Designed for ESP32 Serial.write()</small>
					</div>
				</div>
				<div className="modal-actions">
					<button className="btn btn-secondary" value="cancel" formMethod="dialog" formNoValidate>
						Cancel
					</button>
					<button id="saveContextBtn" className="btn btn-primary" value="default">
						Save context
					</button>
				</div>
			</form>
		</dialog>
	);
}

export function AnnotationDialog() {
	const command = useDialogCommand();
	const annotationCommand = command?.type === "annotation" ? command : null;
	const actions = getDialogActions();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const textRef = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState("");

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (!annotationCommand) {
			if (dialog.open) dialog.close();
			setText("");
			return;
		}
		setText(annotationCommand.text);
		if (!dialog.open) dialog.showModal();
		const frame = requestAnimationFrame(() => textRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [annotationCommand]);

	const valid = annotationTextIsValid(text);

	return (
		<dialog id="noteDialog" className="modal note-modal" ref={dialogRef} onClose={() => setText("")}>
			<form
				id="annotationForm"
				method="dialog"
				onSubmit={event => {
					if (isCancelSubmit(event)) return;
					event.preventDefault();
					if (!annotationCommand || !valid) return;
					if (
						actions.saveAnnotation({
							captureId: annotationCommand.captureId,
							annotationType: annotationCommand.annotationType,
							key: annotationCommand.key,
							text: normalizeAnnotationText(text)
						})
					)
						dialogRef.current?.close();
				}}
			>
				<div className="modal-heading">
					<div>
						<span className="eyebrow">Annotation</span>
						<h2 id="annotationTitle">{annotationCommand?.title || "Note on message"}</h2>
					</div>
					<button className="icon-btn" value="cancel" formMethod="dialog" formNoValidate aria-label="Close">
						×
					</button>
				</div>
				<div id="annotationTarget" className="annotation-target">
					{annotationCommand?.target || ""}
				</div>
				<label className="field">
					Note
					<textarea
						id="annotationText"
						ref={textRef}
						placeholder="Possible checksum, command, status flag…"
						value={text}
						onChange={event => setText(event.currentTarget.value)}
					/>
				</label>
				<div id="annotationHint" className={`validation-hint ${valid ? "ready" : ""}`.trim()} aria-live="polite">
					{valid ? "Ready to save." : "Enter a note to enable saving."}
				</div>
				<div className="modal-actions">
					<button
						id="deleteAnnotationBtn"
						className="btn btn-danger"
						type="button"
						style={{ visibility: annotationCommand?.hasExisting ? "visible" : "hidden" }}
						onClick={() => {
							if (!annotationCommand) return;
							actions.deleteAnnotation({
								captureId: annotationCommand.captureId,
								annotationType: annotationCommand.annotationType,
								key: annotationCommand.key
							});
							dialogRef.current?.close();
						}}
					>
						Delete note
					</button>
					<span />
					<button className="btn btn-secondary" value="cancel" formMethod="dialog" formNoValidate>
						Cancel
					</button>
					<button id="saveAnnotationBtn" className="btn btn-primary" value="default" disabled={!valid}>
						Save note
					</button>
				</div>
			</form>
		</dialog>
	);
}

export function PatternRemarkDialog() {
	const command = useDialogCommand();
	const patternCommand = command?.type === "pattern-remark" ? command : null;
	const actions = getDialogActions();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const textRef = useRef<HTMLTextAreaElement>(null);
	const [text, setText] = useState("");

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (!patternCommand) {
			if (dialog.open) dialog.close();
			setText("");
			return;
		}
		setText(patternCommand.text);
		if (!dialog.open) dialog.showModal();
		const frame = requestAnimationFrame(() => textRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [patternCommand]);

	const patternStyle = patternCommand ? ({ "--pattern-color": patternCommand.color } as CSSProperties) : undefined;

	return (
		<dialog id="patternDialog" className="modal note-modal" ref={dialogRef} style={patternStyle} onClose={() => setText("")}>
			<form
				id="patternRemarkForm"
				method="dialog"
				onSubmit={event => {
					if (isCancelSubmit(event)) return;
					event.preventDefault();
					if (!patternCommand) return;
					if (
						actions.savePatternRemark({
							captureId: patternCommand.captureId,
							patternKey: patternCommand.patternKey,
							text: normalizePatternRemarkText(text)
						})
					)
						dialogRef.current?.close();
				}}
			>
				<div className="modal-heading">
					<div>
						<span className="eyebrow">Recognized sequence</span>
						<h2 id="patternRemarkTitle">{patternCommand?.title || "Sequence note"}</h2>
					</div>
					<button className="icon-btn" value="cancel" formMethod="dialog" formNoValidate aria-label="Close">
						×
					</button>
				</div>
				<div id="patternRemarkTarget" className="pattern-remark-target">
					{patternCommand?.signatures.map((value, index) => (
						<span key={`${index}:${value}`}>
							<b>{String(index + 1).padStart(2, "0")}</b>
							{value}
						</span>
					))}
				</div>
				<label className="field">
					Shared sequence note
					<textarea
						id="patternRemarkText"
						ref={textRef}
						placeholder="What does this repeated exchange appear to represent?"
						value={text}
						onChange={event => setText(event.currentTarget.value)}
					/>
				</label>
				<div id="patternRemarkHint" className="validation-hint" aria-live="polite">
					This note appears in the Sequence column for every occurrence.
				</div>
				<div className="modal-actions">
					<button
						id="deletePatternRemarkBtn"
						className="btn btn-danger"
						type="button"
						style={{ visibility: patternCommand?.hasExisting ? "visible" : "hidden" }}
						onClick={() => {
							if (!patternCommand) return;
							actions.savePatternRemark({
								captureId: patternCommand.captureId,
								patternKey: patternCommand.patternKey,
								text: ""
							});
							dialogRef.current?.close();
						}}
					>
						Delete note
					</button>
					<span />
					<button className="btn btn-secondary" value="cancel" formMethod="dialog" formNoValidate>
						Cancel
					</button>
					<button id="savePatternRemarkBtn" className="btn btn-primary" value="default">
						Save note
					</button>
				</div>
			</form>
		</dialog>
	);
}

export function ExportDialog() {
	const command = useDialogCommand();
	const exportCommand = command?.type === "export" ? command : null;
	const actions = getDialogActions();
	const dialogRef = useRef<HTMLDialogElement>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (!exportCommand) {
			if (dialog.open) dialog.close();
			return;
		}
		if (!dialog.open) dialog.showModal();
	}, [exportCommand]);

	const exportFormat = (format: ExportFormat) => {
		actions.exportData(format);
		dialogRef.current?.close();
	};

	return (
		<dialog id="exportDialog" className="modal" ref={dialogRef}>
			<form method="dialog">
				<DialogHeading eyebrow="Portable evidence" title="Export captures" />
				<div className="export-options">
					<button type="button" data-export="json" onClick={() => exportFormat("json")}>
						<strong>JSON archive</strong>
						<span>All captures, parameters, timing and notes. Re-importable.</span>
					</button>
					<button type="button" data-export="csv" onClick={() => exportFormat("csv")}>
						<strong>CSV table</strong>
						<span>The active capture, ready for a spreadsheet.</span>
					</button>
					<button type="button" data-export="txt" onClick={() => exportFormat("txt")}>
						<strong>Monitor text</strong>
						<span>Human-readable timestamped hex dump with context.</span>
					</button>
				</div>
			</form>
		</dialog>
	);
}
