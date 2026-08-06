import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	useSyncExternalStore,
	type CSSProperties,
	type ChangeEvent as ReactChangeEvent,
	type MouseEvent as ReactMouseEvent
} from "react";
import {
	Virtualizer,
	elementScroll,
	observeElementOffset,
	observeElementRect,
	type VirtualItem
} from "@tanstack/virtual-core";
import {
	getMessageStreamActions,
	getMessageStreamSnapshot,
	subscribeToMessageStream,
	type MessageStreamTarget
} from "./message-stream-bridge";
import {
	colorForByte,
	formatDelta,
	formatTime,
	renderRepeatPillData,
	signature,
	visibleByteEntries,
	type MessageStreamEntry,
	type MessageStreamRow,
	type MessageStreamSnapshot
} from "./message-stream";
import type { SectionMoveAction, SectionMoveAvailability } from "../capture/section-repositioning.ts";

type CSSVariableStyle = CSSProperties & Record<`--${string}`, string | number | undefined>;

type MenuPosition = {
	clientX: number;
	clientY: number;
	origin: HTMLElement | null;
};

type MenuState = MenuPosition &
	(
		| { kind: "message"; target: MessageStreamTarget }
		| {
				kind: "section";
				sectionId: string;
				availability: SectionMoveAvailability;
			}
	);

const VIRTUAL_ROW_HEIGHT = 41;
const VIRTUAL_SECTION_HEIGHT = 48;
const VIRTUAL_OVERSCAN = 8;

function virtualizerOptions(
	snapshot: MessageStreamSnapshot,
	scrollRef: React.MutableRefObject<HTMLDivElement | null>,
	snapshotRef: React.MutableRefObject<MessageStreamSnapshot>,
	onChange: () => void
) {
	return {
		count: snapshot.entries.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: (index: number) =>
			snapshotRef.current.entries[index]?.type === "section" ? VIRTUAL_SECTION_HEIGHT : VIRTUAL_ROW_HEIGHT,
		getItemKey: (index: number) => snapshotRef.current.entries[index]?.key ?? index,
		overscan: VIRTUAL_OVERSCAN,
		scrollToFn: elementScroll,
		observeElementRect,
		observeElementOffset,
		measureElement: (element: HTMLTableRowElement) => element.getBoundingClientRect().height,
		onChange
	};
}

function useMessageVirtualizer(snapshot: MessageStreamSnapshot, scrollRef: React.MutableRefObject<HTMLDivElement | null>) {
	const snapshotRef = useRef(snapshot);
	snapshotRef.current = snapshot;
	const [, setVersion] = useState(0);
	const notify = useCallback(() => setVersion(version => version + 1), []);
	const virtualizerRef = useRef<Virtualizer<HTMLDivElement, HTMLTableRowElement> | null>(null);
	if (!virtualizerRef.current) {
		virtualizerRef.current = new Virtualizer(
			virtualizerOptions(snapshot, scrollRef, snapshotRef, notify)
		);
	}

	useLayoutEffect(() => {
		const virtualizer = virtualizerRef.current;
		if (!virtualizer) return;
		return virtualizer._didMount();
	}, []);

	useLayoutEffect(() => {
		const virtualizer = virtualizerRef.current;
		if (!virtualizer) return;
		virtualizer.setOptions(virtualizerOptions(snapshot, scrollRef, snapshotRef, notify));
		virtualizer._willUpdate();
		setVersion(version => version + 1);
	}, [notify, scrollRef, snapshot]);

	return virtualizerRef.current!;
}

function SectionEntry({
	entry,
	virtualItem,
	rowRef
}: {
	entry: Extract<MessageStreamEntry, { type: "section" }>;
	virtualItem: VirtualItem;
	rowRef: (element: HTMLTableRowElement | null) => void;
}) {
	const { section, sectionNumber } = entry;
	const actions = getMessageStreamActions();
	const sectionLabel = String(sectionNumber).padStart(2, "0");
	const toggleLabel = `${section.collapsed ? "Expand" : "Collapse"} section ${sectionLabel} messages`;
	return (
		<tr
			ref={rowRef}
			className="section-divider"
			data-section-id={section.id}
			data-index={virtualItem.index}
			style={{ transform: `translateY(${virtualItem.start}px)` }}
		>
			<td className="section-number">{String(sectionNumber).padStart(2, "0")}</td>
			<td colSpan={6}>
				<div className="section-header-content">
					<div className="section-header-title">
						<button
							className={`section-toggle ${section.collapsed ? "collapsed" : ""}`.trim()}
							data-section-toggle={section.id}
							type="button"
							aria-expanded={!section.collapsed}
							aria-label={toggleLabel}
							title={toggleLabel}
							onClick={event => {
								event.stopPropagation();
								actions.setSectionCollapsed(section.id, !section.collapsed);
							}}
						>
							<svg viewBox="0 0 24 24" aria-hidden="true">
								<path d="m9 6 6 6-6 6" />
							</svg>
						</button>
						<span>Section · raw byte {section.start + 1}</span>
					</div>
					<div className="section-header-controls">
						<label>
							Message length{" "}
							<input
								data-section-length={section.id}
								type="number"
								min="1"
								max="1024"
								value={section.frameSize}
								onChange={event => actions.setSectionFrameSize(section.id, event.currentTarget.value)}
							/>
							{" "}bytes
						</label>
						<label className="switch-label section-collapse">
							Collapse runs{" "}
							<input
								data-section-collapse={section.id}
								type="checkbox"
								checked={section.collapseRuns}
								onChange={event => actions.setSectionCollapse(section.id, event.currentTarget.checked)}
							/>
							<span className="switch" />
						</label>
					</div>
				</div>
			</td>
		</tr>
	);
}

function RepeatPill({ message }: { message: MessageStreamRow }) {
	const repeat = renderRepeatPillData(message);
	return (
		<span className={`repeat-pill ${repeat.steady ? "steady" : ""}`.trim()} title={repeat.title}>
			<strong>×{message._repeats}</strong>
			<small>{repeat.cadence}</small>
		</span>
	);
}

function MessageEntry({
	entry,
	virtualItem,
	snapshot,
	rowRef
}: {
	entry: Extract<MessageStreamEntry, { type: "message" }>;
	virtualItem: VirtualItem;
	snapshot: MessageStreamSnapshot;
	rowRef: (element: HTMLTableRowElement | null) => void;
}) {
	const { row: message, rowIndex } = entry;
	const patternMember = snapshot.patterns.membership.get(message._originalStart);
	const pattern = patternMember?.group;
	const isPatternStart = patternMember?.offset === 0;
	const patternEndMember = snapshot.patterns.membership.get(message._originalEnd);
	const isPatternEnd = Boolean(
		pattern &&
		patternEndMember?.group.id === pattern.id &&
		patternEndMember.occurrenceIndex === patternMember?.occurrenceIndex &&
		patternEndMember.offset === pattern.length - 1
	);
	const visiblePatternRowCount =
		snapshot.visiblePatternRowCounts.get(message._patternOccurrence || "") || pattern?.length;
	const originalRow = message._originalStart + 1;
	const sequenceNote = snapshot.sequenceNotes.find(
		note => originalRow >= note.start && originalRow <= note.end
	);
	const messageNote = snapshot.annotations[message.id];
	const isUnique = snapshot.signatureCounts.get(signature(message)) === 1;
	const rowLabel =
		message._originalStart === message._originalEnd
			? originalRow
			: `${originalRow}–${message._originalEnd + 1}`;
	const visibleBytes = visibleByteEntries(message);
	const sentByteCount = visibleBytes.filter(({ rawPosition }) => message.directions?.[rawPosition] === "tx").length;
	const hasSentBytes = sentByteCount > 0;
	const directionTag = hasSentBytes ? (sentByteCount === visibleBytes.length ? "TX" : "MIXED") : "";
	const rowClasses = [
		sequenceNote ? "sequence-noted" : "",
		isUnique ? "unique-message" : "",
		hasSentBytes ? "sent-message" : "",
		pattern ? "pattern-member" : "",
		isPatternStart ? "pattern-start" : "",
		isPatternEnd ? "pattern-end" : ""
	]
		.filter(Boolean)
		.join(" ");
	const rowTitles = [
		isUnique ? "Unique telegram · this signature occurs once in the capture" : "",
		sequenceNote ? `Sequence rows ${sequenceNote.start}–${sequenceNote.end}: ${sequenceNote.text}` : "",
		pattern
			? `Repeated sequence · occurrence ${patternMember?.occurrenceIndex! + 1} of ${pattern.starts.length}${
					pattern.remark ? ` · ${pattern.remark}` : ""
			  }`
			: ""
	]
		.filter(Boolean)
		.join(" · ");
	const rowStyle: CSSVariableStyle = {
		transform: `translateY(${virtualItem.start}px)`,
		...(pattern
			? {
					"--pattern-color": pattern.color,
					"--sequence-row-count": visiblePatternRowCount,
					"--sequence-row-height": `${virtualItem.size}px`
			  }
			: {})
	};

	const sequenceControl = pattern ? (
		<td className="sequence-cell" style={{ "--pattern-color": pattern.color } as CSSVariableStyle}>
			<button
				className={`sequence-group ${isPatternStart ? "sequence-group-start" : ""} ${
					isPatternEnd ? "sequence-group-end" : ""
				}`.trim()}
				data-pattern-id={pattern.id}
				title={`Sequence ${String(snapshot.patternNumbers.get(pattern.id)).padStart(2, "0")} · occurrence ${
					patternMember?.occurrenceIndex! + 1
				} of ${pattern.starts.length} · ${pattern.length} messages${
					pattern.remark ? ` · shared note: ${pattern.remark}` : " · add a shared note"
				}`}
				aria-label={pattern.remark ? "Edit shared sequence note" : "Add shared sequence note"}
				type="button"
			>
				<span className="sequence-rail" aria-hidden="true">
					<span className="sequence-rail-endcap" />
				</span>
				{isPatternStart ? (
					<span className="sequence-summary">
						<span className="sequence-label">
							SEQ {String(snapshot.patternNumbers.get(pattern.id)).padStart(2, "0")} <b>{pattern.length} rows</b>
						</span>
						<span className="sequence-occurrence">
							{patternMember?.occurrenceIndex! + 1} / {pattern.starts.length}
						</span>
						<span className={`sequence-note ${pattern.remark ? "" : "empty"}`.trim()}>
							{pattern.remark || "+ Add shared note"}
						</span>
					</span>
				) : (
					<span className="sequence-continuation" aria-hidden="true" />
				)}
			</button>
		</td>
	) : (
		<td className="sequence-cell">
			<span className="sequence-empty">—</span>
		</td>
	);

	return (
		<tr
			ref={rowRef}
			data-index={virtualItem.index}
			data-message-id={message.id}
			className={rowClasses}
			style={rowStyle}
			title={rowTitles}
		>
			<td>{rowLabel}</td>
			<td>
				{formatTime(message.timestamp)}
				{directionTag ? <span className="direction-tag">{directionTag}</span> : null}
			</td>
			<td>{formatDelta(message._delta)}</td>
			{sequenceControl}
			<td>
				<div className="byte-row">
					{visibleBytes.map(({ value: byte, rawPosition }, position) => {
						const count = snapshot.countsByPosition[position]?.get(byte) || 0;
						const frame = snapshot.frames[rowIndex]?.[position] || { incoming: null, outgoing: null };
						const incoming = frame.incoming;
						const outgoing = frame.outgoing;
						const previousRow = snapshot.matchingRows[rowIndex - 1];
						const previousIsAdjacent = Boolean(
							previousRow &&
							message._originalStart === previousRow._originalEnd + 1 &&
							message.sectionId === previousRow.sectionId
						);
						const previousByte = previousIsAdjacent
							? visibleByteEntries(previousRow!)[position]?.value
							: undefined;
						const changedFromPrevious = previousIsAdjacent && previousByte !== byte;
						const changed = Boolean(snapshot.highlight && (changedFromPrevious || incoming || outgoing));
						const noted = snapshot.annotations[`${message.id}:${rawPosition}`];
						const sent = message.directions?.[rawPosition] === "tx";
						const binary = byte.toString(2).padStart(8, "0");
						const receivedAt = new Date(message.byteTimestamps?.[rawPosition] ?? message.timestamp).toISOString();
						const directionLabel = sent ? "sent to RS-485" : "received from serial";
						const transitions = [incoming?.label, outgoing?.label].filter(Boolean);
						const transitionTitle = transitions.length
							? ` · framed transition${transitions.length > 1 ? "s" : ""}: ${transitions.join(" / ")}`
							: "";
						const byteClasses = [
							"byte",
							snapshot.mode === "binary" ? "binary" : "",
							changed ? "changed" : "",
							count === 1 ? "rare" : "",
							noted ? "noted" : "",
							sent ? "sent" : "",
							incoming ? "has-incoming" : "",
							incoming?.start ? "in-start" : "",
							incoming?.end ? "in-end" : "",
							outgoing ? "has-outgoing" : "",
							outgoing?.start ? "out-start" : "",
							outgoing?.end ? "out-end" : ""
						]
							.filter(Boolean)
							.join(" ");
						const byteStyle: CSSVariableStyle = {
							"--byte-color": colorForByte(byte),
							...(incoming
								? {
										"--in-color": incoming.color,
										"--in-offset": `${-3 - incoming.lane * 3}px`
								  }
								: {}),
							...(outgoing
								? {
										"--out-color": outgoing.color,
										"--out-offset": `${-3 - outgoing.lane * 3}px`
								  }
								: {})
						};
						return (
							<button
								key={`${message.id}:${rawPosition}`}
								className={byteClasses}
								style={byteStyle}
								data-byte-note={`${message.id}:${rawPosition}`}
								title={`Byte ${position + 1} · ${directionLabel} ${receivedAt} · ${count} occurrence(s)${transitionTitle} · click to annotate · right-click for actions`}
								type="button"
							>
								<span className="byte-value">
									{snapshot.mode === "binary" ? (
										<>
											{binary.slice(0, 4)}<i>·</i>{binary.slice(4)}
										</>
									) : (
										formatByte(byte)
									)}
								</span>
							</button>
						);
					})}
				</div>
			</td>
			<td>{message._repeats > 1 ? <RepeatPill message={message} /> : "—"}</td>
			<td>
				<div className="row-actions">
					{messageNote || sequenceNote ? (
						<button className="note-link" data-message-note={message.id} type="button">
							{messageNote?.text || `↳ ${sequenceNote?.text}`}
						</button>
					) : (
						<button className="row-action add-note" data-message-note={message.id} type="button">
							＋ Add note
						</button>
					)}
					<button
						className="row-action replay-link"
						data-message-replay={message.id}
						title="Replay this message on the connected serial port"
						type="button"
					>
						↻ Replay
					</button>
				</div>
			</td>
		</tr>
	);
}

function formatByte(byte: number): string {
	return byte.toString(16).padStart(2, "0").toUpperCase();
}

const SECTION_MOVE_ACTIONS: Array<{ action: SectionMoveAction; label: string }> = [
	{ action: "byte-before", label: "Move one byte before" },
	{ action: "byte-after", label: "Move one byte after" },
	{ action: "message-before", label: "Move one message before" },
	{ action: "message-after", label: "Move one message after" }
];

function SectionMoveIcon({ action }: { action: SectionMoveAction }) {
	const movesBefore = action.endsWith("before");
	const isMessage = action.startsWith("message");
	const arrow = isMessage
		? movesBefore
			? "M15 19V5m0 0-5 5m5-5 5 5"
			: "M15 5v14m0 0-5-5m5 5 5-5"
		: movesBefore
			? "M19 12H5m0 0 5-5m-5 5 5 5"
			: "M5 12h14m0 0-5-5m5 5-5 5";
	const messageLines = "M4.5 5.5h4M4.5 12h4M4.5 18.5h4";

	return (
		<svg viewBox="0 0 24 24" aria-hidden="true">
			{isMessage ? (
				<>
					<path d={messageLines} />
					<path d={arrow} />
				</>
			) : (
				<path d={arrow} />
			)}
		</svg>
	);
}

function MessageContextMenu({ state, onClose }: { state: MenuState | null; onClose: (restoreFocus?: boolean) => void }) {
	const menuRef = useRef<HTMLDivElement>(null);
	const positionRef = useRef({ left: 10, top: 10 });
	const [position, setPosition] = useState({ left: 10, top: 10 });
	positionRef.current = position;

	useLayoutEffect(() => {
		if (!state || !menuRef.current) return;
		const edge = 10;
		const bounds = menuRef.current.getBoundingClientRect();
		const next = {
			left: Math.max(edge, Math.min(state.clientX, window.innerWidth - bounds.width - edge)),
			top: Math.max(edge, Math.min(state.clientY, window.innerHeight - bounds.height - edge))
		};
		if (next.left !== positionRef.current.left || next.top !== positionRef.current.top) setPosition(next);
	}, [state]);

	const actions = getMessageStreamActions();
	const target = state?.kind === "message" ? state.target : undefined;
	const deleteLabel = target?.position === null ? "Delete message" : "Delete byte";

	const handleAction = (action: string) => {
		if (!state) return;
		if (state.kind === "section") {
			const sectionAction = SECTION_MOVE_ACTIONS.find(item => item.action === action)?.action;
			if (!sectionAction || !state.availability[sectionAction]) return;
			onClose();
			actions.moveSection(state.sectionId, sectionAction);
			return;
		}
		if (!target) return;
		onClose();
		if (action === "note") {
			if (target.position === null) actions.openMessageNote(target.messageId);
			else actions.openByteNote(target.messageId, target.position);
		} else if (action === "replay") {
			actions.replayMessage(target.messageId);
		} else if (action === "delete") {
			if (target.position === null) actions.hideMessage(target.messageId);
			else actions.hideByte(target.messageId, target.position);
		} else if (action === "section" && target.position !== null) {
			actions.beginSection(target.messageId, target.position);
		}
	};

	return (
		<div
			id={state?.kind === "section" ? "sectionContextMenu" : "messageContextMenu"}
			ref={menuRef}
			className={`message-context-menu ${state ? "" : "hidden"}`.trim()}
			style={{ left: position.left, top: position.top }}
			role="menu"
			aria-label={state?.kind === "section" ? "Section actions" : "Message actions"}
			aria-hidden={state ? "false" : "true"}
		>
			{state?.kind === "section" ? (
				SECTION_MOVE_ACTIONS.map(({ action, label }) => (
					<button
						key={action}
						type="button"
						role="menuitem"
						className="section-context-action"
						data-context-action={action}
						data-section-action={action}
						disabled={!state.availability[action]}
						onClick={() => handleAction(action)}
					>
						<SectionMoveIcon action={action} />
						<span>{label}</span>
					</button>
				))
			) : (
				<>
					<button type="button" role="menuitem" data-context-action="note" onClick={() => handleAction("note")}>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M4.5 4.5h10.25L19.5 9.25V19.5H4.5Z" />
							<path d="M14.75 4.5v4.75h4.75M8 14.5h4.5M8 17.5h6.5" />
						</svg>
						<span>Add note</span>
					</button>
					<button type="button" role="menuitem" data-context-action="replay" onClick={() => handleAction("replay")}>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M19 8.5A7.5 7.5 0 1 0 19.15 15" />
							<path d="M19 4.5v4h-4" />
						</svg>
						<span>Replay</span>
					</button>
					<button
						type="button"
						role="menuitem"
						className="context-delete"
						data-context-action="delete"
						aria-label={`${deleteLabel} (keep data hidden)`}
						onClick={() => handleAction("delete")}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M5.5 7.5h13M9.5 7.5V5h5v2.5M7 7.5l.75 12h8.5L17 7.5M10 11v5.5M14 11v5.5" />
						</svg>
						<span>{deleteLabel}</span>
					</button>
					<button
						type="button"
						role="menuitem"
						className={`byte-context-action ${target?.position === null ? "hidden" : ""}`.trim()}
						data-context-action="section"
						onClick={() => handleAction("section")}
					>
						<svg viewBox="0 0 24 24" aria-hidden="true">
							<path d="M5 4.5v15M19 4.5v15M5 8.5h5M14 8.5h5M5 15.5h5M14 15.5h5" />
						</svg>
						<span>Begin new section here</span>
					</button>
				</>
			)}
		</div>
	);
}

export function MessageStream({ frameSizeLabel }: { frameSizeLabel: string }) {
	const snapshot = useSyncExternalStore(
		subscribeToMessageStream,
		getMessageStreamSnapshot,
		getMessageStreamSnapshot
	);
	const actions = getMessageStreamActions();
	const scrollRef = useRef<HTMLDivElement>(null);
	const previousFilter = useRef(snapshot.filterQuery);
	const [menuState, setMenuState] = useState<MenuState | null>(null);
	const virtualizer = useMessageVirtualizer(snapshot, scrollRef);

	useEffect(() => {
		if (snapshot.filterQuery !== previousFilter.current) {
			scrollRef.current?.scrollTo({ top: 0 });
			previousFilter.current = snapshot.filterQuery;
		}
	}, [snapshot.filterQuery]);

	const closeMenu = useCallback((restoreFocus = false) => {
		setMenuState(current => {
			if (restoreFocus && current?.origin?.isConnected) current.origin.focus();
			return null;
		});
	}, []);

	useEffect(() => {
		if (!menuState) return;
		const closeOnOutsideClick = (event: MouseEvent) => {
			const menu = document.getElementById("messageContextMenu") || document.getElementById("sectionContextMenu");
			if (!event.target || !menu?.contains(event.target as Node)) {
				closeMenu();
			}
		};
		const closeOnOutsideContextMenu = (event: MouseEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			if (!target?.closest("#messageContextMenu, #sectionContextMenu, #messageBody")) {
				closeMenu();
			}
		};
		const closeOnEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape") closeMenu(true);
		};
		const closeOnResize = () => closeMenu();
		document.addEventListener("click", closeOnOutsideClick);
		document.addEventListener("contextmenu", closeOnOutsideContextMenu);
		document.addEventListener("keydown", closeOnEscape);
		window.addEventListener("resize", closeOnResize);
		return () => {
			document.removeEventListener("click", closeOnOutsideClick);
			document.removeEventListener("contextmenu", closeOnOutsideContextMenu);
			document.removeEventListener("keydown", closeOnEscape);
			window.removeEventListener("resize", closeOnResize);
		};
	}, [closeMenu, menuState]);

	const openContextMenu = (event: ReactMouseEvent<HTMLTableSectionElement>) => {
		const targetElement = event.target instanceof Element ? event.target : null;
		const sectionRow = targetElement?.closest<HTMLTableRowElement>("tr[data-section-id]");
		if (sectionRow) {
			const sectionId = sectionRow.dataset.sectionId;
			const entry = snapshot.entries.find(item => item.type === "section" && item.section.id === sectionId);
			if (!sectionId || !entry || entry.type !== "section") return;
			event.preventDefault();
			setMenuState({
				kind: "section",
				sectionId,
				availability: entry.section.moveAvailability,
				clientX: event.clientX,
				clientY: event.clientY,
				origin: (targetElement?.closest("button") as HTMLElement | null) || sectionRow
			});
			return;
		}
		const row = targetElement?.closest<HTMLTableRowElement>("tr[data-message-id]");
		if (!row) return;
		const byteButton = targetElement?.closest<HTMLElement>("[data-byte-note]");
		const messageId = row.dataset.messageId;
		const byteKey = byteButton?.dataset.byteNote;
		const positionText = byteKey?.split(":")[1];
		const position = byteButton && positionText !== undefined ? Number(positionText) : null;
		if (!messageId || (byteButton && !Number.isInteger(position))) return;
		event.preventDefault();
		setMenuState({
			kind: "message",
			target: { messageId, position },
			clientX: event.clientX,
			clientY: event.clientY,
			origin: (targetElement?.closest("button") as HTMLElement | null) || row
		});
	};

	const handleClick = (event: ReactMouseEvent<HTMLTableSectionElement>) => {
		const targetElement = event.target instanceof Element ? event.target : null;
		const noteButton = targetElement?.closest<HTMLElement>("[data-message-note]");
		if (noteButton?.dataset.messageNote) return actions.openMessageNote(noteButton.dataset.messageNote);
		const replayButton = targetElement?.closest<HTMLElement>("[data-message-replay]");
		if (replayButton?.dataset.messageReplay) return actions.replayMessage(replayButton.dataset.messageReplay);
		const patternButton = targetElement?.closest<HTMLElement>("[data-pattern-id]");
		if (patternButton?.dataset.patternId) return actions.openPatternRemark(patternButton.dataset.patternId);
		const byteButton = targetElement?.closest<HTMLElement>("[data-byte-note]");
		const byteKey = byteButton?.dataset.byteNote;
		if (byteKey) {
			const [messageId, positionText] = byteKey.split(":");
			const position = Number(positionText);
			if (messageId && Number.isInteger(position)) actions.openByteNote(messageId, position);
		}
	};

	const handleChange = (event: ReactChangeEvent<HTMLTableSectionElement>) => {
		const targetElement = event.target instanceof Element ? event.target : null;
		const lengthInput = targetElement?.closest<HTMLInputElement>("[data-section-length]");
		if (lengthInput?.dataset.sectionLength) {
			actions.setSectionFrameSize(lengthInput.dataset.sectionLength, lengthInput.value);
			return;
		}
		const collapseInput = targetElement?.closest<HTMLInputElement>("[data-section-collapse]");
		if (collapseInput?.dataset.sectionCollapse) {
			actions.setSectionCollapse(collapseInput.dataset.sectionCollapse, collapseInput.checked);
		}
	};

	return (
		<div className="table-wrap" ref={scrollRef} onScroll={() => menuState && closeMenu()}>
			<table className={`message-table ${snapshot.hasMatchingRows ? "" : "hidden"}`.trim()}>
				<thead>
					<tr>
						<th>#</th>
						<th>TIME</th>
						<th>Δ</th>
						<th className="sequence-heading">SEQUENCE</th>
						<th>
							MESSAGE · <span id="frameSizeLabel">{frameSizeLabel}</span>
						</th>
						<th>REPEATS</th>
						<th>ANNOTATION</th>
					</tr>
				</thead>
				<tbody
					id="messageBody"
					style={{ height: virtualizer.getTotalSize() }}
					onClick={handleClick}
					onContextMenu={openContextMenu}
					onChange={handleChange}
				>
					{virtualizer.getVirtualItems().map(virtualItem => {
						const entry = snapshot.entries[virtualItem.index];
						if (!entry) return null;
						const ref = (element: HTMLTableRowElement | null) => {
							if (element) virtualizer.measureElement(element);
						};
						return entry.type === "section" ? (
							<SectionEntry key={entry.key} entry={entry} virtualItem={virtualItem} rowRef={ref} />
						) : (
							<MessageEntry
								key={entry.key}
								entry={entry}
								virtualItem={virtualItem}
								snapshot={snapshot}
								rowRef={ref}
							/>
						);
					})}
				</tbody>
			</table>
			<div id="emptyState" className={`empty-state ${snapshot.hasMatchingRows ? "hidden" : ""}`.trim()}>
				<div className="empty-glyph">
					01<span>10</span>
				</div>
				<h2>{snapshot.emptyState.title}</h2>
				<p>{snapshot.emptyState.description}</p>
			</div>
			<MessageContextMenu state={menuState} onClose={closeMenu} />
		</div>
	);
}
