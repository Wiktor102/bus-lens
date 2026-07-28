const STORAGE_KEY = "bus-lens-state-v1";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const BYTE_COLORS = ["#79D8E7", "#CBF45A", "#F2B84B", "#B99AF7", "#FF8178", "#69D5A5", "#7DA9FF", "#E48AC2", "#5BD6C8", "#F08C62", "#A8B7FF", "#E76F7B"];
const TRANSITION_COLORS = ["#36C8E8", "#9E65F4", "#F39C4A", "#E35D91", "#5A8FFF", "#49C88A"];

const demoCaptures = [
  {
    id: crypto.randomUUID(), name: "Overview · Speed 1", view: "Overview",
    params: [{ key: "Speed", value: "1" }, { key: "Mode", value: "auto / program 1" }],
    createdAt: "2026-07-28T12:39:07.009Z", frameSize: 3, baudRate: 115200, inputFormat: "text",
    messages: [
      ["12:39:07.009","C2 08 5D"],["12:39:07.088","C2 08 5D"],["12:39:07.182","C2 00 5D"],
      ["12:39:07.222","C2 08 5D"],["12:39:07.341","C2 08 5D"],["12:39:07.387","C2 00 5D"],
      ["12:39:07.481","C2 08 5D"],["12:39:07.528","C2 08 5D"],["12:39:07.605","C2 00 5D"],
      ["12:39:07.648","C2 08 5D"],["12:39:07.747","C2 08 5D"],["12:39:07.790","C2 08 5D"],
      ["12:39:08.167","C2 00 5D"],["12:39:09.844","C2 08 4D"],["12:49:49.917","3B D6 FC"],
      ["12:49:49.960","C2 88 5D"],["12:49:50.039","C2 80 5D"],["12:49:50.133","C2 88 5D"],
      ["12:49:50.177","C2 88 4D"],["12:49:50.244","C2 80 5D"]
    ].map(([time, hex], i) => makeMessage(hex, parseTime(time), i)),
    notes: [{ id: crypto.randomUUID(), type: "capture", text: "FC appears once immediately after returning to the Overview view; investigate as a possible screen transition marker.", createdAt: Date.now() }],
    annotations: {}
  },
  {
    id: crypto.randomUUID(), name: "Speed · 1 → 2", view: "Speed",
    params: [{ key: "Speed", value: "1 → 2" }, { key: "Ventilation type", value: "full" }],
    createdAt: "2026-07-28T12:57:39.091Z", frameSize: 3, baudRate: 115200, inputFormat: "text",
    messages: [
      ["12:57:39.091","42 3A 9C"],["12:57:39.160","42 3A DC"],["12:57:39.250","4A 3A DC"],
      ["12:57:39.344","42 3A DC"],["12:57:39.390","4A 3A DC"],["12:57:39.470","42 3A DC"],
      ["12:57:39.516","42 E1 9C"],["12:57:39.628","4A E1 9C"],["12:57:39.674","42 E9 9C"],
      ["12:57:39.769","42 E1 9C"],["12:57:39.814","4A E1 9C"],["12:57:39.894","4A E9 9C"],
      ["12:57:39.939","4A E1 8C"],["12:57:40.010","42 E9 8C"],["12:57:40.098","42 E1 9C"]
    ].map(([time, hex], i) => makeMessage(hex, parseTime(time), i)),
    notes: [], annotations: {}
  }
];

let state = loadState();
let activeId = state.activeId || state.captures[0]?.id;
let port = null;
let reader = null;
let recording = false;
let readAbort = false;
let textRemainder = "";
let rawRemainder = [];
let annotationTarget = null;
let captureNoteTargetId = null;
let toastTimer = null;

function makeMessage(hex, timestamp = Date.now(), index = 0) {
  const bytes = typeof hex === "string" ? (hex.match(/[0-9a-f]{2}/gi) || []).map(v => parseInt(v, 16)) : [...hex];
  return { id: crypto.randomUUID(), timestamp, bytes, sourceIndex: index };
}

function parseTime(value) {
  const match = value.match(/(\d{2}):(\d{2}):(\d{2})[.:](\d{3})/);
  if (!match) return Date.now();
  const d = new Date();
  d.setHours(+match[1], +match[2], +match[3], +match[4]);
  return d.getTime();
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (Array.isArray(saved?.captures)) {
      saved.captures.forEach(capture => (capture.notes || []).forEach(note => note.id ||= crypto.randomUUID()));
      return saved;
    }
  } catch {}
  return { captures: demoCaptures, activeId: demoCaptures[0].id };
}

function saveState() {
  state.activeId = activeId;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function capture() {
  return state.captures.find(c => c.id === activeId) || state.captures[0];
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString("en-GB", {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, fractionalSecondDigits: 3
  });
}

function formatDelta(ms) {
  if (ms === null) return "—";
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)} min`;
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
}

function hexByte(byte) { return byte.toString(16).padStart(2, "0").toUpperCase(); }
function signature(message) { return message.bytes.map(hexByte).join(" "); }
function hashText(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
function colorForByte(byte) {
  const paletteIndex = (byte * 13 + (byte >> 4) * 7) % BYTE_COLORS.length;
  return BYTE_COLORS[paletteIndex];
}
function colorForTransition(key) { return TRANSITION_COLORS[hashText(key) % TRANSITION_COLORS.length]; }
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, ch => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#039;" })[ch]);
}

function showToast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 2600);
}

function render() {
  renderCaptureList();
  if (!capture()) {
    renderEmptyWorkspace();
    return;
  }
  renderHeader();
  renderStats();
  renderMessages();
  renderAnalysis();
  renderNotes();
}

function renderEmptyWorkspace() {
  $("#captureTitle").value = "No captures yet";
  $("#captureTitle").disabled = true;
  $("#captureState").textContent = "EMPTY";
  $("#captureState").classList.remove("live");
  $("#captureMeta").innerHTML = `<span class="meta-chip">Use ＋ to create a capture, or import an existing dump.</span>`;
  $("#editContextBtn").disabled = true;
  $("#moreBtn").disabled = true;
  $("#connectBtn").disabled = true;
  $("#recordBtn").disabled = true;
  $("#exportBtn").disabled = true;
  $("#statMessages").textContent = "0";
  $("#statUnique").textContent = "0";
  $("#statDuplicate").textContent = "0%";
  $("#statInterval").textContent = "—";
  $("#statVariants").textContent = "—";
  $("#frameSizeLabel").textContent = "—";
  $("#messageBody").innerHTML = "";
  $(".message-table").classList.add("hidden");
  $("#emptyState").classList.remove("hidden");
  $("#emptyState h2").textContent = "No captures in the archive";
  $("#emptyState p").textContent = "Create a capture or import a monitor dump to begin.";
  $("#visibleCount").textContent = "0 rows";
  $("#signatureList").innerHTML = `<span class="muted">No capture selected.</span>`;
  $("#vocabulary").innerHTML = "";
  $("#bitMap").innerHTML = "";
  $("#transitionList").innerHTML = `<span class="muted">No capture selected.</span>`;
  $("#notesList").innerHTML = `<p class="muted">No capture selected.</p>`;
  $("#notesCount").textContent = "0";
  $("#captureNoteRail").classList.add("hidden");
  $("#headerCaptureNotes").innerHTML = "";
  $("#headerNoteCount").textContent = "0";
  $("#addCaptureNoteBtn").disabled = true;
}

function renderCaptureList() {
  const query = $("#captureSearch").value.toLowerCase();
  const items = state.captures.filter(c => `${c.name} ${c.view} ${c.params.map(p => `${p.key} ${p.value}`).join(" ")}`.toLowerCase().includes(query));
  $("#captureList").innerHTML = items.map(c => `
    <button class="capture-item ${c.id === activeId ? "active" : ""}" data-capture-id="${c.id}">
      <strong>${escapeHtml(c.name)}</strong>
      <small><span>${escapeHtml(c.view || "Unassigned view")}</span><span>${c.messages.length} msg</span></small>
      <span class="capture-tags">${c.params.slice(0,2).map(p => `<i>${escapeHtml(p.key)}: ${escapeHtml(p.value)}</i>`).join("")}</span>
    </button>`).join("") || `<p class="muted" style="padding:12px">No matching captures.</p>`;
  $$("[data-capture-id]").forEach(el => el.onclick = () => { activeId = el.dataset.captureId; saveState(); render(); });
}

function renderHeader() {
  const c = capture();
  if (!c) return;
  $("#captureTitle").value = c.name;
  $("#captureTitle").disabled = false;
  $("#editContextBtn").disabled = false;
  $("#moreBtn").disabled = false;
  $("#connectBtn").disabled = false;
  $("#recordBtn").disabled = !port;
  $("#exportBtn").disabled = false;
  $("#captureNoteRail").classList.remove("hidden");
  $("#addCaptureNoteBtn").disabled = false;
  $("#captureMeta").innerHTML = [
    c.view && `<span class="meta-chip"><b>VIEW</b> ${escapeHtml(c.view)}</span>`,
    ...c.params.map(p => `<span class="meta-chip"><b>${escapeHtml(p.key.toUpperCase())}</b> ${escapeHtml(p.value)}</span>`),
    `<span class="meta-chip"><b>FRAME</b> ${c.frameSize} bytes</span>`
  ].filter(Boolean).join("");
  $("#frameSizeLabel").textContent = `${c.frameSize} BYTE${c.frameSize === 1 ? "" : "S"}`;
  $("#captureState").textContent = recording ? "● LIVE" : "SAVED";
  $("#captureState").classList.toggle("live", recording);
  renderHeaderCaptureNotes();
}

function captureLevelNotes(c = capture()) {
  return (c?.notes || []).filter(note => note.type === "capture").sort((a,b) => b.createdAt - a.createdAt);
}

function renderHeaderCaptureNotes() {
  const notes = captureLevelNotes();
  $("#headerNoteCount").textContent = notes.length;
  $("#captureNoteRail").classList.toggle("empty", notes.length === 0);
  $("#headerCaptureNotes").innerHTML = notes.length
    ? notes.slice(0, 2).map(note => `
      <button class="header-capture-note" data-capture-note-id="${note.id}" title="Edit capture note">
        <span>${escapeHtml(note.text)}</span>
        <small>${new Date(note.updatedAt || note.createdAt).toLocaleDateString()}${note.updatedAt ? " · edited" : ""}</small>
      </button>`).join("") + (notes.length > 2 ? `<span class="header-note-overflow">＋${notes.length - 2} more in Notes</span>` : "")
    : `<button class="header-note-empty" data-new-capture-note>
        <span>Pin an observation to this capture</span>
        <small>Visible here while you inspect telegrams</small>
      </button>`;
  $$("[data-capture-note-id]").forEach(button => button.onclick = () => openCaptureNoteEditor(button.dataset.captureNoteId));
  $$("[data-new-capture-note]").forEach(button => button.onclick = () => openCaptureNoteEditor());
}

function getCounts(messages) {
  const counts = new Map();
  messages.forEach(m => counts.set(signature(m), (counts.get(signature(m)) || 0) + 1));
  return counts;
}

function renderStats() {
  const c = capture();
  const messages = c?.messages || [];
  const counts = getCounts(messages);
  const intervals = messages.slice(1).map((m,i) => m.timestamp - messages[i].timestamp).filter(n => n >= 0 && n < 60000);
  const variants = Array.from({ length: c?.frameSize || 0 }, (_,i) => new Set(messages.map(m => m.bytes[i]).filter(v => v !== undefined)).size);
  $("#statMessages").textContent = messages.length.toLocaleString();
  $("#statUnique").textContent = counts.size.toLocaleString();
  $("#statDuplicate").textContent = messages.length ? `${Math.round((1 - counts.size/messages.length) * 100)}%` : "0%";
  $("#statInterval").textContent = intervals.length ? `${Math.round(intervals.reduce((a,b)=>a+b,0)/intervals.length)} ms` : "—";
  $("#statVariants").textContent = variants.length ? variants.join(" / ") : "—";
}

function filteredMessages() {
  const c = capture();
  let rows = (c?.messages || []).map((message, originalIndex) => ({
    ...message,
    _originalStart: originalIndex,
    _originalEnd: originalIndex,
    _runStart: message.timestamp,
    _runEnd: message.timestamp,
    _runMessages: [message],
    _repeats: 1
  }));
  const query = $("#messageFilter").value.trim().toUpperCase();
  if (query) {
    const pattern = query.split(/\s+/).map(x => x === "??" || x === "**" ? "[0-9A-F]{2}" : x.replace(/[^0-9A-F?]/g, "").replaceAll("?", "[0-9A-F]")).join("\\s+");
    try { const re = new RegExp(pattern); rows = rows.filter(m => re.test(signature(m))); } catch {}
  }
  if ($("#collapseToggle").checked) {
    const collapsed = [];
    rows.forEach(m => {
      const last = collapsed.at(-1);
      const isAdjacent = last && m._originalStart === last._originalEnd + 1;
      if (isAdjacent && signature(last) === signature(m)) {
        last._repeats++;
        last._originalEnd = m._originalEnd;
        last._runEnd = m.timestamp;
        last._runMessages.push(m);
      } else collapsed.push(m);
    });
    rows = collapsed;
  }
  return rowsWithDelta(rows.map(summarizeRunCadence));
}

function rowsWithDelta(rows) {
  return rows.map((m,i) => ({
    ...m,
    _delta: i && m._originalStart === rows[i-1]._originalEnd + 1
      ? m._runStart - rows[i-1]._runEnd
      : null
  }));
}

function summarizeRunCadence(message) {
  const intervals = message._runMessages.slice(1).map((item, index) =>
    item.timestamp - message._runMessages[index].timestamp
  ).filter(interval => Number.isFinite(interval) && interval >= 0);
  if (!intervals.length) return { ...message, _cadence: null, _cadenceStable: false, _intervals: intervals };
  const sorted = [...intervals].sort((a,b) => a-b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle-1] + sorted[middle]) / 2;
  const tolerance = Math.max(2, median * .1);
  const stable = intervals.every(interval => Math.abs(interval - median) <= tolerance);
  const average = intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length;
  return { ...message, _cadence: stable ? average : null, _cadenceStable: stable, _intervals: intervals };
}

function transitionFrames(rows) {
  const frames = rows.map(row => row.bytes.map(() => ({ incoming: null, outgoing: null })));
  for (let rowIndex = 0; rowIndex < rows.length - 1; rowIndex++) {
    const fromRow = rows[rowIndex];
    const toRow = rows[rowIndex + 1];
    if (toRow._originalStart !== fromRow._originalEnd + 1) continue;
    const comparable = Math.min(fromRow.bytes.length, toRow.bytes.length);
    const unchanged = Array.from({ length: comparable }, (_, position) => position)
      .filter(position => fromRow.bytes[position] === toRow.bytes[position]);
    const changed = Array.from({ length: comparable }, (_, position) => position)
      .filter(position => fromRow.bytes[position] !== toRow.bytes[position]);
    if (!unchanged.length || !changed.length) continue;

    const groups = [];
    changed.forEach(position => {
      const group = groups.at(-1);
      if (group && position === group.at(-1) + 1) group.push(position);
      else groups.push([position]);
    });

    groups.forEach(group => {
      const start = group[0];
      const end = group.at(-1);
      const from = group.map(position => hexByte(fromRow.bytes[position])).join(" ");
      const to = group.map(position => hexByte(toRow.bytes[position])).join(" ");
      const key = `${from}→${to}`;
      const descriptor = {
        color: colorForTransition(key),
        lane: hashText(key) % 3,
        label: `${from} → ${to}`
      };
      group.forEach(position => {
        frames[rowIndex][position].outgoing = {
          ...descriptor,
          start: position === start,
          end: position === end
        };
        frames[rowIndex + 1][position].incoming = {
          ...descriptor,
          start: position === start,
          end: position === end
        };
      });
    });
  }
  return frames;
}

function renderMessages() {
  const c = capture();
  if (!c) return;
  const rows = filteredMessages();
  const signatureCounts = getCounts(c.messages);
  const countsByPosition = Array.from({length:c.frameSize}, (_,pos) => {
    const map = new Map();
    c.messages.forEach(m => map.set(m.bytes[pos], (map.get(m.bytes[pos]) || 0) + 1));
    return map;
  });
  const mode = $("#displayMode").value;
  const highlight = $("#uniqueToggle").checked;
  const frames = highlight
    ? transitionFrames(rows)
    : rows.map(row => row.bytes.map(() => ({ incoming: null, outgoing: null })));
  const telegramCount = rows.reduce((sum, row) => sum + row._repeats, 0);
  $("#visibleCount").textContent = telegramCount === rows.length
    ? `${rows.length} row${rows.length === 1 ? "" : "s"}`
    : `${rows.length} rows · ${telegramCount} telegrams`;
  $("#messageBody").innerHTML = rows.map((m,i) => {
    const messageNote = c.annotations[m.id];
    const originalRow = m._originalStart + 1;
    const sequenceNote = (c.notes || []).find(n => n.type === "sequence" && originalRow >= n.start && originalRow <= n.end);
    const isUnique = signatureCounts.get(signature(m)) === 1;
    const rowLabel = m._originalStart === m._originalEnd ? originalRow : `${originalRow}–${m._originalEnd + 1}`;
    const rowClasses = [sequenceNote ? "sequence-noted" : "", isUnique ? "unique-message" : ""].filter(Boolean).join(" ");
    const rowTitles = [
      isUnique ? "Unique telegram · this signature occurs once in the capture" : "",
      sequenceNote ? `Sequence rows ${sequenceNote.start}–${sequenceNote.end}: ${sequenceNote.text}` : ""
    ].filter(Boolean).join(" · ");
    return `<tr data-message-id="${m.id}" class="${rowClasses}" title="${escapeHtml(rowTitles)}">
      <td>${rowLabel}</td>
      <td>${formatTime(m.timestamp)}</td>
      <td>${formatDelta(m._delta)}</td>
      <td><div class="byte-row">${m.bytes.map((byte,pos) => {
        const count = countsByPosition[pos]?.get(byte) || 0;
        const frame = frames[i][pos] || {};
        const incoming = frame.incoming;
        const outgoing = frame.outgoing;
        const previousIsAdjacent = i && m._originalStart === rows[i-1]._originalEnd + 1;
        const changedFromPrevious = previousIsAdjacent && rows[i-1].bytes[pos] !== byte;
        const changed = highlight && (changedFromPrevious || incoming || outgoing);
        const noted = c.annotations[`${m.id}:${pos}`];
        const binary = byte.toString(2).padStart(8,"0");
        const content = mode === "binary" ? `${binary.slice(0,4)}<i>·</i>${binary.slice(4)}` : hexByte(byte);
        const classes = [
          "byte",
          mode === "binary" ? "binary" : "",
          changed ? "changed" : "",
          count === 1 ? "rare" : "",
          noted ? "noted" : "",
          incoming ? "has-incoming" : "",
          incoming?.start ? "in-start" : "",
          incoming?.end ? "in-end" : "",
          outgoing ? "has-outgoing" : "",
          outgoing?.start ? "out-start" : "",
          outgoing?.end ? "out-end" : ""
        ].filter(Boolean).join(" ");
        const styles = [
          `--byte-color:${colorForByte(byte)}`,
          incoming && `--in-color:${incoming.color}`,
          incoming && `--in-offset:${-3 - incoming.lane * 3}px`,
          outgoing && `--out-color:${outgoing.color}`,
          outgoing && `--out-offset:${-3 - outgoing.lane * 3}px`
        ].filter(Boolean).join(";");
        const transitions = [incoming?.label, outgoing?.label].filter(Boolean);
        const transitionTitle = transitions.length
          ? ` · framed transition${transitions.length > 1 ? "s" : ""}: ${transitions.join(" / ")}`
          : "";
        return `<button class="${classes}" style="${styles}" data-byte-note="${m.id}:${pos}" title="Byte ${pos + 1} · ${count} occurrence(s)${transitionTitle} · click to annotate"><span class="byte-value">${content}</span></button>`;
      }).join("")}</div></td>
      <td>${m._repeats > 1 ? renderRepeatPill(m) : "—"}</td>
      <td><button class="note-link ${messageNote || sequenceNote ? "" : "add-note"}" data-message-note="${m.id}">${escapeHtml(messageNote?.text || (sequenceNote ? `↳ ${sequenceNote.text}` : "＋ Add note"))}</button></td>
    </tr>`;
  }).join("");
  $("#emptyState").classList.toggle("hidden", c.messages.length > 0);
  $("#emptyState h2").textContent = "No messages in this capture";
  $("#emptyState p").textContent = "Connect a serial port and start capture, or import a monitor dump.";
  $(".message-table").classList.toggle("hidden", c.messages.length === 0);
  $$("[data-message-note]").forEach(el => el.onclick = () => openAnnotation("message", el.dataset.messageNote));
  $$("[data-byte-note]").forEach(el => el.onclick = () => openAnnotation("byte", el.dataset.byteNote));
}

function renderRepeatPill(message) {
  const min = Math.min(...message._intervals);
  const max = Math.max(...message._intervals);
  const range = message._intervals.length ? `${formatDelta(min)}${min === max ? "" : `–${formatDelta(max)}`}` : "—";
  const cadence = message._cadenceStable && message._cadence !== null
    ? `<small>≈ ${formatDelta(Math.round(message._cadence))}</small>`
    : `<small>varied</small>`;
  const title = `${message._repeats} consecutive identical telegrams · interval ${range}`;
  return `<span class="repeat-pill ${message._cadenceStable ? "steady" : ""}" title="${title}"><strong>×${message._repeats}</strong>${cadence}</span>`;
}

function renderAnalysis() {
  const c = capture();
  if (!c) return;
  const counts = [...getCounts(c.messages).entries()].sort((a,b) => b[1]-a[1]);
  const maxCount = counts[0]?.[1] || 1;
  $("#signatureList").innerHTML = counts.slice(0,10).map(([sig,n]) => `
    <div class="signature-row"><span>${sig}</span><span class="signature-bar"><i style="width:${n/maxCount*100}%"></i></span><small>${n} · ${Math.round(n/c.messages.length*100)}%</small></div>
  `).join("") || `<span class="muted">No messages to analyze.</span>`;

  $("#vocabulary").innerHTML = Array.from({length:c.frameSize},(_,pos) => {
    const values = new Map();
    c.messages.forEach(m => { if (m.bytes[pos] !== undefined) values.set(m.bytes[pos], (values.get(m.bytes[pos]) || 0) + 1); });
    return `<div class="vocab-row"><label>BYTE ${pos+1}</label><div class="vocab-values">${[...values.entries()].sort((a,b)=>b[1]-a[1]).map(([v,n]) => `<span title="${n} occurrences">${hexByte(v)}<small> ·${n}</small></span>`).join("")}</div></div>`;
  }).join("");

  $("#bitMap").innerHTML = Array.from({length:c.frameSize},(_,pos) => {
    const bytes = c.messages.map(m => m.bytes[pos]).filter(v => v !== undefined);
    return `<div class="bit-row"><label>BYTE ${pos+1}</label>${Array.from({length:8},(_,idx) => {
      const bit = 7-idx;
      const ones = bytes.filter(v => (v >> bit) & 1).length;
      const ratio = bytes.length ? ones/bytes.length : 0;
      const variance = Math.min(ratio, 1-ratio) * 2;
      return `<div class="bit-cell" style="--variance:${variance.toFixed(2)}" title="${Math.round(ratio*100)}% ones"><span>b${bit}<br>${Math.round(ratio*100)}%</span></div>`;
    }).join("")}</div>`;
  }).join("");

  const transitions = new Map();
  c.messages.slice(1).forEach((m,i) => {
    const from = signature(c.messages[i]), to = signature(m);
    if (from !== to) transitions.set(`${from}|${to}`, (transitions.get(`${from}|${to}`) || 0) + 1);
  });
  $("#transitionList").innerHTML = [...transitions.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12).map(([key,n]) => {
    const [from,to] = key.split("|");
    const diffs = from.split(" ").filter((v,i) => v !== to.split(" ")[i]).length;
    return `<div class="transition-row"><span>${from}</span><b>→</b><span>${to}</span><small>${n}× · ${diffs} byte${diffs===1?"":"s"} changed</small></div>`;
  }).join("") || `<span class="muted">No transitions yet.</span>`;
}

function allNotes() {
  const c = capture();
  if (!c) return [];
  const captureNotes = (c.notes || []).map(n => ({...n, label:n.type === "sequence" ? "SEQUENCE" : "CAPTURE"}));
  const annotations = Object.entries(c.annotations || {}).map(([key,n]) => ({...n, id:key, label:key.includes(":") ? "BYTE" : "MESSAGE"}));
  return [...captureNotes, ...annotations].sort((a,b) => b.createdAt-a.createdAt);
}

function renderNotes() {
  const notes = allNotes();
  $("#notesCount").textContent = notes.length;
  $("#notesList").innerHTML = notes.map(n => `
    <article class="note-card"><header><span>${n.label}${n.targetLabel ? ` · ${escapeHtml(n.targetLabel)}` : ""}</span><span>${new Date(n.createdAt).toLocaleString()}</span></header><p>${escapeHtml(n.text)}</p></article>
  `).join("") || `<p class="muted">No observations recorded for this capture.</p>`;
}

function openCaptureNoteEditor(noteId = null) {
  const note = noteId ? captureLevelNotes().find(item => item.id === noteId) : null;
  captureNoteTargetId = note?.id || null;
  $("#captureNoteEditorTitle").textContent = note ? "Edit capture note" : "Add capture note";
  $("#captureNoteEditorText").value = note?.text || "";
  $("#deleteCaptureNoteBtn").style.visibility = note ? "visible" : "hidden";
  updateCaptureNoteValidity();
  $("#captureNoteDialog").showModal();
  $("#captureNoteEditorText").focus();
}

function updateCaptureNoteValidity() {
  const hasText = $("#captureNoteEditorText").value.trim().length > 0;
  $("#saveCaptureNoteBtn").disabled = !hasText;
  $("#captureNoteEditorHint").textContent = hasText ? "Ready to pin in the capture header." : "Enter a note to enable saving.";
  $("#captureNoteEditorHint").classList.toggle("ready", hasText);
  return hasText;
}

function saveCaptureNote() {
  if (!updateCaptureNoteValidity()) return false;
  const c = capture();
  const text = $("#captureNoteEditorText").value.trim();
  if (captureNoteTargetId) {
    const note = (c.notes || []).find(item => item.id === captureNoteTargetId);
    if (!note) return false;
    note.text = text;
    note.updatedAt = Date.now();
  } else {
    c.notes ||= [];
    c.notes.push({ id:crypto.randomUUID(), type:"capture", text, createdAt:Date.now() });
  }
  saveState();
  renderHeader();
  renderNotes();
  showToast(captureNoteTargetId ? "Capture note updated" : "Capture note added");
  return true;
}

function openContext(isNew = false) {
  const c = isNew ? { name:"Untitled capture", view:"", params:[], baudRate:115200, inputFormat:"raw", frameSize:3 } : capture();
  $("#contextDialog").dataset.mode = isNew ? "new" : "edit";
  $("#contextName").value = c.name;
  $("#contextView").value = c.view;
  $("#baudRate").value = c.baudRate;
  $("#inputFormat").value = c.inputFormat;
  $("#frameSize").value = c.frameSize;
  $("#parameterRows").innerHTML = "";
  c.params.forEach(p => addParameterRow(p.key,p.value));
  if (!c.params.length) addParameterRow("Speed","");
  $("#contextDialog").showModal();
}

function addParameterRow(key="",value="") {
  const row = document.createElement("div");
  row.className = "parameter-row";
  row.innerHTML = `<input placeholder="Parameter" value="${escapeHtml(key)}"><input placeholder="Value" value="${escapeHtml(value)}"><button type="button" aria-label="Remove">×</button>`;
  row.querySelector("button").onclick = () => row.remove();
  $("#parameterRows").append(row);
}

function saveContext() {
  const params = $$("#parameterRows .parameter-row").map(row => {
    const [key,value] = [...row.querySelectorAll("input")].map(x=>x.value.trim());
    return {key,value};
  }).filter(p => p.key);
  const values = {
    name: $("#contextName").value.trim() || "Untitled capture",
    view: $("#contextView").value.trim(),
    params, baudRate:+$("#baudRate").value, inputFormat:$("#inputFormat").value,
    frameSize:Math.max(1,Math.min(64,+$("#frameSize").value || 3))
  };
  if ($("#contextDialog").dataset.mode === "new") {
    const c = { id:crypto.randomUUID(), ...values, createdAt:new Date().toISOString(), messages:[], notes:[], annotations:{} };
    state.captures.unshift(c); activeId = c.id;
  } else Object.assign(capture(), values);
  saveState(); render(); showToast("Capture context saved");
}

function openAnnotation(type,key) {
  const c = capture();
  annotationTarget = { type, key };
  const [messageId,posText] = key.split(":");
  const m = c.messages.find(x => x.id === messageId);
  const pos = posText === undefined ? null : +posText;
  const targetKey = type === "byte" ? key : messageId;
  const existing = c.annotations[targetKey];
  $("#annotationTitle").textContent = type === "byte" ? `Note on byte ${pos+1}` : "Note on message";
  $("#annotationTarget").textContent = type === "byte" ? `${formatTime(m.timestamp)}  ·  ${signature(m)}  ·  BYTE ${pos+1} = ${hexByte(m.bytes[pos])}` : `${formatTime(m.timestamp)}  ·  ${signature(m)}`;
  $("#annotationText").value = existing?.text || "";
  $("#deleteAnnotationBtn").style.visibility = existing ? "visible" : "hidden";
  updateAnnotationValidity();
  $("#noteDialog").showModal();
  $("#annotationText").focus();
}

function updateAnnotationValidity() {
  const hasText = $("#annotationText").value.trim().length > 0;
  $("#saveAnnotationBtn").disabled = !hasText;
  $("#annotationHint").textContent = hasText ? "Ready to save." : "Enter a note to enable saving.";
  $("#annotationHint").classList.toggle("ready", hasText);
  return hasText;
}

function saveAnnotation() {
  if (!updateAnnotationValidity()) return false;
  const c = capture();
  const {type,key} = annotationTarget;
  const [messageId,pos] = key.split(":");
  const m = c.messages.find(x => x.id === messageId);
  const targetKey = type === "byte" ? key : messageId;
  c.annotations[targetKey] = {
    text:$("#annotationText").value.trim(), createdAt:Date.now(),
    type, targetLabel:type === "byte" ? `${signature(m)} · byte ${+pos+1}` : signature(m)
  };
  saveState(); render(); showToast("Annotation saved");
  return true;
}

async function connectSerial() {
  if (!capture()) return showToast("Create a capture before connecting a port");
  if (!("serial" in navigator)) {
    showToast("Web Serial requires Chrome or Edge on localhost");
    return;
  }
  if (port) {
    await disconnectSerial(); return;
  }
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate:capture().baudRate || 115200 });
    $("#connectionBadge").innerHTML = "<i></i> Port connected";
    $("#connectionBadge").classList.add("connected");
    $("#connectBtn").textContent = "Disconnect";
    $("#recordBtn").disabled = false;
    readAbort = false;
    readSerialLoop();
  } catch (error) {
    port = null;
    showToast(error.name === "NotFoundError" ? "No serial port selected" : `Serial error: ${error.message}`);
  }
}

async function disconnectSerial() {
  recording = false; readAbort = true;
  try { await reader?.cancel(); reader?.releaseLock(); await port?.close(); } catch {}
  reader = null; port = null;
  $("#connectionBadge").innerHTML = "<i></i> Disconnected";
  $("#connectionBadge").classList.remove("connected");
  $("#connectBtn").textContent = "Connect port";
  $("#recordBtn").disabled = true;
  $("#recordBtn").classList.remove("recording");
  $("#recordBtn").innerHTML = "<span></span> Start capture";
  renderHeader();
}

async function readSerialLoop() {
  while (port?.readable && !readAbort) {
    reader = port.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (recording && value) ingestChunk(value);
      }
    } catch (error) {
      if (!readAbort) showToast(`Read error: ${error.message}`);
    } finally {
      try { reader.releaseLock(); } catch {}
      reader = null;
    }
  }
}

function ingestChunk(bytes) {
  const c = capture();
  if (c.inputFormat === "text") {
    textRemainder += new TextDecoder().decode(bytes, {stream:true});
    const lines = textRemainder.split(/\r?\n/);
    textRemainder = lines.pop();
    lines.forEach(line => {
      const timeMatch = line.match(/(\d{2}:\d{2}:\d{2}[.:]\d{3})/);
      const afterArrow = line.includes("->") ? line.split("->").at(-1) : line;
      const hex = afterArrow.match(/\b[0-9a-f]{2}\b/gi) || [];
      for (let i=0; i+c.frameSize<=hex.length; i+=c.frameSize) appendMessage(hex.slice(i,i+c.frameSize).map(x=>parseInt(x,16)), timeMatch ? parseTime(timeMatch[1]) : Date.now());
    });
  } else {
    rawRemainder.push(...bytes);
    while (rawRemainder.length >= c.frameSize) appendMessage(rawRemainder.splice(0,c.frameSize), Date.now());
  }
}

function appendMessage(bytes,timestamp) {
  capture().messages.push(makeMessage(bytes,timestamp,capture().messages.length));
  saveState();
  renderStats(); renderMessages(); renderAnalysis();
}

function toggleRecording() {
  recording = !recording;
  textRemainder = ""; rawRemainder = [];
  $("#recordBtn").classList.toggle("recording",recording);
  $("#recordBtn").innerHTML = recording ? "<span></span> Stop capture" : "<span></span> Start capture";
  renderHeader();
  showToast(recording ? "Capture started" : "Capture saved locally");
}

function parseDump(text) {
  const sections = text.split(/\n\s*----+\s*\n/).map(s=>s.trim()).filter(s=>/View\s*:/i.test(s));
  return sections.map((section,index) => {
    const lines = section.split(/\r?\n/);
    const view = lines.find(l=>/^View\s*:/i.test(l))?.split(":").slice(1).join(":").trim() || "Imported";
    const params = [];
    for (const line of lines) {
      if (/^\d{2}:\d{2}:\d{2}/.test(line) || /^View\s*:/i.test(line) || /^\(/.test(line) || /^\.{3}/.test(line)) continue;
      const m = line.match(/^([^:]+):\s*(.+)$/);
      if (m) params.push({key:m[1].trim(),value:m[2].trim()});
    }
    const messages = [];
    lines.forEach(line => {
      const tm = line.match(/^(\d{2}:\d{2}:\d{2}[.:]\d{3})\s*->\s*((?:[0-9A-F]{2}\s*)+)/i);
      if (tm) messages.push(makeMessage(tm[2],parseTime(tm[1]),messages.length));
    });
    return { id:crypto.randomUUID(), name:`${view} · imported ${index+1}`, view, params, createdAt:new Date().toISOString(), frameSize:3, baudRate:115200, inputFormat:"text", messages, notes:[], annotations:{} };
  }).filter(c=>c.messages.length);
}

async function importFile(file) {
  try {
    const text = await file.text();
    if (file.name.toLowerCase().endsWith(".json")) {
      const imported = JSON.parse(text);
      const captures = Array.isArray(imported) ? imported : imported.captures;
      if (!Array.isArray(captures)) throw new Error("No captures found");
      captures.forEach(c => {
        c.id ||= crypto.randomUUID();
        c.annotations ||= {};
        c.notes ||= [];
        c.notes.forEach(note => note.id ||= crypto.randomUUID());
        c.messages.forEach(m=>m.id ||= crypto.randomUUID());
      });
      state.captures.unshift(...captures); activeId = captures[0].id;
    } else {
      const captures = parseDump(text);
      if (!captures.length) throw new Error("No timestamped hex messages found");
      state.captures.unshift(...captures); activeId = captures[0].id;
    }
    saveState(); render(); showToast(`Imported ${file.name}`);
  } catch (error) { showToast(`Import failed: ${error.message}`); }
}

function download(content,filename,type) {
  const url = URL.createObjectURL(new Blob([content],{type}));
  const a = document.createElement("a"); a.href=url; a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function exportData(format) {
  const c = capture();
  const safeName = c.name.replace(/[^a-z0-9_-]+/gi,"-").toLowerCase();
  if (format === "json") {
    download(JSON.stringify({app:"Bus Lens",version:1,exportedAt:new Date().toISOString(),captures:state.captures},null,2),"bus-lens-archive.json","application/json");
  } else if (format === "csv") {
    const quote = value => `"${String(value ?? "").replaceAll('"','""')}"`;
    const header = ["index","timestamp","delta_ms",...Array.from({length:c.frameSize},(_,i)=>`byte_${i+1}_hex`),"message_hex","message_note"];
    const rows = c.messages.map((m,i) => [i+1,new Date(m.timestamp).toISOString(),i?m.timestamp-c.messages[i-1].timestamp:"",...m.bytes.map(hexByte),signature(m),c.annotations[m.id]?.text||""].map(quote).join(","));
    download([header.join(","),...rows].join("\n"),`${safeName}.csv`,"text/csv");
  } else {
    const noteLines = (c.notes || []).map(n => `# ${n.type === "sequence" ? `Rows ${n.start}-${n.end}` : "Capture"}: ${n.text}`);
    const context = [`----`,`View: ${c.view}`,...c.params.map(p=>`${p.key}: ${p.value}`),...noteLines,"",...c.messages.map(m=>`${formatTime(m.timestamp)} -> ${signature(m)}${c.annotations[m.id] ? `  <-- ${c.annotations[m.id].text}` : ""}`),"","----"].join("\n");
    download(context,`${safeName}.txt`,"text/plain");
  }
  $("#exportDialog").close(); showToast(`${format.toUpperCase()} export created`);
}

$("#connectBtn").onclick = connectSerial;
$("#recordBtn").onclick = toggleRecording;
$("#newCaptureBtn").onclick = () => openContext(true);
$("#editContextBtn").onclick = () => openContext(false);
$("#addCaptureNoteBtn").onclick = () => openCaptureNoteEditor();
$("#addParameterBtn").onclick = () => addParameterRow();
$("#contextForm").addEventListener("submit", e => { if (e.submitter?.value === "cancel") return; e.preventDefault(); saveContext(); $("#contextDialog").close(); });
$("#captureTitle").onchange = e => {
  if (!capture()) return;
  capture().name=e.target.value.trim()||"Untitled capture"; saveState(); renderCaptureList();
};
$("#captureSearch").oninput = renderCaptureList;
$("#messageFilter").oninput = renderMessages;
$("#displayMode").onchange = renderMessages;
$("#uniqueToggle").onchange = renderMessages;
$("#collapseToggle").onchange = renderMessages;
$("#moreBtn").onclick = () => $("#moreMenu").classList.toggle("hidden");
$("#duplicateCaptureBtn").onclick = () => {
  const copy = structuredClone(capture()); copy.id=crypto.randomUUID(); copy.name += " · copy"; copy.createdAt=new Date().toISOString();
  copy.messages.forEach(m=>m.id=crypto.randomUUID()); copy.annotations={}; state.captures.unshift(copy); activeId=copy.id; saveState(); render(); $("#moreMenu").classList.add("hidden");
};
$("#clearMessagesBtn").onclick = () => {
  if (confirm("Clear all messages and message annotations from this capture?")) { capture().messages=[]; capture().annotations={}; saveState(); render(); }
  $("#moreMenu").classList.add("hidden");
};
$("#deleteCaptureBtn").onclick = async () => {
  if (confirm(`Delete “${capture().name}”?`)) {
    if (port) await disconnectSerial();
    state.captures=state.captures.filter(c=>c.id!==activeId);
    activeId=state.captures[0]?.id || null;
    saveState(); render();
  }
  $("#moreMenu").classList.add("hidden");
};
$$(".tab").forEach(tab => tab.onclick = () => {
  $$(".tab").forEach(x=>x.classList.toggle("active",x===tab));
  $$(".tab-panel").forEach(x=>x.classList.remove("active"));
  $(`#${tab.dataset.panel}Panel`).classList.add("active");
});
$("#captureNoteForm").onsubmit = e => {
  e.preventDefault();
  if (!capture()) return;
  const type = $("#noteScope").value;
  const note = {id:crypto.randomUUID(),type,text:$("#captureNoteText").value.trim(),createdAt:Date.now()};
  if (type === "sequence") {
    const max = Math.max(1,capture().messages.length);
    note.start = Math.max(1,Math.min(max,+$("#sequenceStart").value || 1));
    note.end = Math.max(note.start,Math.min(max,+$("#sequenceEnd").value || note.start));
    note.targetLabel = `rows ${note.start}–${note.end}`;
  }
  capture().notes.push(note);
  $("#captureNoteText").value=""; saveState(); renderHeader(); renderNotes(); renderMessages(); showToast("Observation added");
};
$("#noteScope").onchange = e => $("#sequenceRange").classList.toggle("hidden",e.target.value !== "sequence");
$("#captureNoteEditorText").addEventListener("input",updateCaptureNoteValidity);
$("#captureNoteEditorForm").addEventListener("submit",e => {
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();
  if (saveCaptureNote()) $("#captureNoteDialog").close();
});
$("#deleteCaptureNoteBtn").onclick = () => {
  const c = capture();
  c.notes = (c.notes || []).filter(note => note.id !== captureNoteTargetId);
  saveState();
  renderHeader();
  renderNotes();
  $("#captureNoteDialog").close();
  showToast("Capture note removed");
};
$("#annotationText").addEventListener("input",updateAnnotationValidity);
$("#annotationForm").addEventListener("submit",e => {
  if (e.submitter?.value === "cancel") return;
  e.preventDefault();
  if (saveAnnotation()) $("#noteDialog").close();
});
$("#deleteAnnotationBtn").onclick = () => {
  const key = annotationTarget.type === "byte" ? annotationTarget.key : annotationTarget.key.split(":")[0];
  delete capture().annotations[key]; saveState(); render(); $("#noteDialog").close(); showToast("Annotation removed");
};
$("#importBtn").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = e => { if(e.target.files[0]) importFile(e.target.files[0]); e.target.value=""; };
$("#exportBtn").onclick = () => $("#exportDialog").showModal();
$$("[data-export]").forEach(btn => btn.onclick = () => exportData(btn.dataset.export));
document.addEventListener("click",e => { if (!e.target.closest(".header-actions")) $("#moreMenu").classList.add("hidden"); });
window.addEventListener("beforeunload",() => { if(port) disconnectSerial(); });

render();
