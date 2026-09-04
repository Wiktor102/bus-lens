import { useEffect, useRef, useState, type FormEvent, type CSSProperties } from "react";
import { useApplicationSelector, useApplicationStore } from "../../app/application-store-provider.tsx";
import { selectCanonicalization, selectDialog } from "../../shared/application-store.ts";
import { getDialogActions } from "./dialog-bridge";
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
import { AlertTriangle, Check, Plus, Trash2, X } from "lucide-react";
import { DialogHeading } from "./dialog-components";

function isCancelSubmit(event: FormEvent<HTMLFormElement>): boolean {
	return ((event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null)?.value === "cancel";
}

function useDialogCommand() {
	return useApplicationSelector(selectDialog);
}

export function ConfirmationDialog() {
	const command = useDialogCommand();
	const confirmationCommand = command?.type === "confirmation" ? command : null;
	const actions = getDialogActions();
	const dialogRef = useRef<HTMLDialogElement>(null);
	const cancelRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (!confirmationCommand) {
			if (dialog.open) dialog.close();
			return;
		}
		if (!dialog.open) dialog.showModal();
		const frame = requestAnimationFrame(() => cancelRef.current?.focus());
		return () => cancelAnimationFrame(frame);
	}, [confirmationCommand]);

	const dismiss = () => {
		actions.dismiss();
		dialogRef.current?.close();
	};

	const confirm = () => {
		if (!confirmationCommand) return;
		actions.confirm(confirmationCommand.action);
		dialogRef.current?.close();
	};

	return (
		<dialog
			id="confirmationDialog"
			className="modal confirmation-modal"
			ref={dialogRef}
			role="alertdialog"
			aria-labelledby="confirmationTitle"
			aria-describedby="confirmationMessage confirmationDetail"
			onCancel={event => {
				event.preventDefault();
				dismiss();
			}}
		>
			<DialogHeading
				eyebrow={confirmationCommand?.eyebrow}
				title={confirmationCommand?.title || "Are you sure?"}
				titleId="confirmationTitle"
				className="confirmation-heading"
				leading={
					<span className="confirmation-signal" aria-hidden="true">
						<AlertTriangle />
					</span>
				}
				onClose={dismiss}
			/>
			<div className="confirmation-copy">
				<p id="confirmationMessage">{confirmationCommand?.message || "This action cannot be undone."}</p>
				<p id="confirmationDetail">{confirmationCommand?.detail || "Review the impact before continuing."}</p>
			</div>
			<div className="modal-actions confirmation-actions">
				<button ref={cancelRef} className="btn btn-secondary" type="button" onClick={dismiss}>
					Keep it
				</button>
				<button className="btn btn-danger confirmation-confirm" type="button" onClick={confirm}>
					<Trash2 aria-hidden="true" />
					{confirmationCommand?.confirmLabel || "Continue"}
				</button>
			</div>
		</dialog>
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
							<Plus aria-hidden="true" /> Add parameter
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
									<X aria-hidden="true" />
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
						<X aria-hidden="true" />
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
						<X aria-hidden="true" />
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

export function CanonicalizationDialog() {
	const snapshot = useApplicationSelector(selectCanonicalization);
	const store = useApplicationStore();
	const actions = {
		close: () => store.sendCommand({ type: "canonicalization/close" }),
		download: () => store.sendCommand({ type: "canonicalization/download" }),
		start: () => store.sendCommand({ type: "canonicalization/start" }),
		retry: () => store.sendCommand({ type: "canonicalization/retry" })
	};
	const dialogRef = useRef<HTMLDialogElement>(null);
	const preflight = snapshot.preflight;
	const job = snapshot.job;
	const terminalFailure = job?.status === "failed";
	const terminalSuccess = job?.status === "completed" && job.verified;
	const canStart = Boolean(preflight?.eligible && !preflight.recordingActive && !snapshot.starting && !snapshot.loading);

	useEffect(() => {
		const dialog = dialogRef.current;
		if (!dialog) return;
		if (!snapshot.open) {
			if (dialog.open) dialog.close();
			return;
		}
		if (!dialog.open) dialog.showModal();
	}, [snapshot.open]);

	return (
		<dialog
			id="canonicalizationDialog"
			className="modal canonicalization-modal"
			ref={dialogRef}
			onCancel={event => {
				event.preventDefault();
				actions.close();
			}}
			onClose={() => actions.close()}
		>
			<div className="modal-heading">
				<div>
					<span className="eyebrow">Storage migration</span>
					<h2>Upgrade capture storage</h2>
				</div>
				<button className="icon-btn" type="button" aria-label="Close" onClick={() => actions.close()}><X aria-hidden="true" /></button>
			</div>
			<p className="modal-lede">
				{snapshot.captureName || "This capture"} will be converted only after you explicitly start the operation.
			</p>
			<ul className="canonicalization-safeguards">
				<li>The original capture will be backed up.</li>
				<li>Raw bytes, framing, sections, notes, annotations, sequences, and metadata will be verified.</li>
				<li>The capture cannot be edited during conversion.</li>
				<li>Successful conversion enables canonical queries and agent analysis.</li>
				<li>Conversion does not alter the original serial data.</li>
			</ul>
			{preflight ? (
				<div className="canonicalization-preflight" aria-label="Conversion preflight">
					<div><span>Capture size</span><strong>{preflight.captureSize.toLocaleString()} bytes</strong></div>
					<div><span>Messages</span><strong>{preflight.messageCount.toLocaleString()}</strong></div>
					<div><span>Notes</span><strong>{preflight.noteCount.toLocaleString()}</strong></div>
					<div><span>Storage</span><strong>{preflight.existingStorageStatus || "legacy-not-canonicalized"}</strong></div>
					<div><span>Recording</span><strong>{preflight.recordingActive ? "Active" : "Stopped"}</strong></div>
					<div><span>Eligibility</span><strong>{preflight.eligible ? "Eligible" : preflight.estimatedEligibility}</strong></div>
				</div>
			) : snapshot.loading ? <p className="validation-hint">Checking conversion eligibility…</p> : null}
			{snapshot.error || preflight?.error ? <p className="conversion-error" role="alert">{snapshot.error || preflight?.error}</p> : null}
			{job && (job.status === "running" || job.status === "pending") ? (
				<div className="conversion-progress" role="status" aria-live="polite">
					<strong>CONVERTING</strong>
					<span>{Math.round(job.progress * 100)}% · verification in progress</span>
				</div>
			) : null}
			{terminalSuccess ? (
				<div className="conversion-success" role="status">
					<strong>Verification passed</strong>
					<span>The capture has been reloaded from canonical storage.</span>
					{job.verification ? <VerificationChecks verification={job.verification} /> : null}
				</div>
			) : null}
			{terminalFailure ? (
				<div className="conversion-failure" role="alert">
					<strong>Verification failed</strong>
					<span>{job.error || "The legacy capture was kept unchanged."}</span>
					{job.verification ? <VerificationChecks verification={job.verification} /> : null}
				</div>
			) : null}
			<div className="modal-actions">
				<button className="btn btn-secondary" type="button" onClick={() => actions.download()} disabled={!snapshot.captureId || snapshot.starting}>
					Download original JSON
				</button>
				<span />
				{terminalFailure ? (
					<button className="btn btn-primary" type="button" onClick={() => actions.retry()} disabled={snapshot.starting}>
						Retry conversion
					</button>
				) : terminalSuccess ? (
					<button className="btn btn-primary" type="button" onClick={() => actions.close()}>Done</button>
				) : (
					<button id="startCanonicalizationBtn" className="btn btn-primary" type="button" onClick={() => actions.start()} disabled={!canStart}>
						{snapshot.starting ? "Starting…" : preflight?.recordingActive ? "Stop recording first" : "Start conversion"}
					</button>
				)}
			</div>
		</dialog>
	);
}

function VerificationChecks({ verification }: { verification: { rawBytesMatched: boolean; framesMatched: boolean; sectionsMatched: boolean; notesMatched: boolean; analysisMatched: boolean } }) {
	const checks = [
		["Raw bytes", verification.rawBytesMatched],
		["Frames", verification.framesMatched],
		["Sections", verification.sectionsMatched],
		["Notes", verification.notesMatched],
		["Analysis", verification.analysisMatched]
	] as const;
	return <div className="verification-checks">{checks.map(([label, passed]) => <span key={label} className={passed ? "passed" : "failed"}>{passed ? <Check aria-hidden="true" /> : <X aria-hidden="true" />} {label}</span>)}</div>;
}
