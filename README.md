# Bus Lens

A local-first RS-485 capture and protocol-analysis workbench. It uses the browser's
Web Serial API, so run it in a current Chromium-based browser (Chrome or Edge).

## Development

Install dependencies once, then start the Vite development server:

```powershell
cd D:\Dokumenty\dom\wentylacja\rs485-lab
pnpm install
pnpm start
```

`npm install` and `npm start` are equivalent when npm is preferred.

Open the local address printed in the terminal. It normally uses
`http://127.0.0.1:4173`; if that port is occupied, Bus Lens automatically tries
the next available port.

Useful checks:

```powershell
pnpm test
pnpm typecheck
pnpm build
pnpm preview
```

The application is implemented with React 19, TypeScript, and Vite. The static
workbench shell is split into focused React components. Protocol capture and
analysis code is loaded as a separate chunk after the first render, and the
message table keeps its virtualized rendering path for large captures.

## Source layout

Source is organized by responsibility: `src/app/` contains application wiring and
the root UI, `src/features/` contains archive, capture, analysis, message-stream,
send, transport, notes, dialogs, and data-transfer modules, and `src/shared/`
contains cross-feature state and utilities. React components live at the UI
feature boundary; controllers and domain modules remain DOM-free.

## Agent query pagination

Agent query `limit` values are maximums, not guaranteed page sizes. Each pageable
response reports the validated `requestedLimit`, the `effectiveLimit` used for
that response, and the actual `returned` count. When more matching evidence is
available, `meta.truncated` is true; `meta.page.truncationReason` distinguishes
a reached `page-limit` from a response-size reduction. Cursors remain bound to
their evidence filters and snapshots, not to page size, so callers may change
`limit` while continuing with an existing cursor.

## MCP evidence workflow

The MCP guide at `buslens://guide` documents the evidence-navigation workflow.
Use `list_framing_profiles` before interpreting a capture: choose its raw-data
selection for `read_raw_bytes`, its current selection for the active framing, or
one historical selection for a deliberate profile revision. Raw bytes are source
evidence; interpreted frames and analysis rows belong to the selected profile.
Pass `profileId`, `profileVersion`, and `sourceDataRevision` together so an
analytical result cannot silently switch revisions.

Hidden bytes and frames remain retained and can be included or excluded. Deleted
notes, captures, or cleared raw data are unavailable rather than hidden. Use
`query_notes` for bounded note text and exact anchors, and request
`includeNoteSummaries` from `get_message_context` when note IDs alone are not
enough. Notes can record actions taken and known states; they should distinguish
observations from hypotheses and retain their evidence anchors.

## Capture framing

The serial input is a raw binary stream, compatible with ESP32 `Serial.write()`, or
a directional sniffer stream of `A5 direction value` records. In sniffer mode,
`A5 00 XX` is RX and `A5 01 XX` is TX relative to the monitored device. Every
captured byte is stored with its own timestamp before any framing is applied.
The Arduino-ESP32 3.x reference firmware is in
[`firmware/esp32-rmt-sniffer`](firmware/esp32-rmt-sniffer); it uses RMT waveform
capture so byte direction is determined at wire time instead of UART FIFO
consumption time.

Every capture is sectioned. The first section starts at raw byte 1, and each
section header has its own **Frame by** mode and settings, so one capture can
frame different parts of the stream independently. Sections support fixed
length, marker (marker starts or ends a message), and idle time-gap framing.
Open a section header's context menu to move its boundary by one byte or one
framed message; changing a section's framing settings rebuilds only that
section's messages. New sections default to length framing and retain the preceding section's other framing
settings.

Legacy captures that used the previous global framing settings are migrated to
sections when loaded, while their raw byte stream remains preserved. The old
top-level framing fields remain readable in JSON for import compatibility but
do not override normalized section settings.

Because the timestamp is recorded when a Web Serial read delivers a byte, multiple
bytes delivered in the same browser read may have effectively identical times.

Capture context, messages, parameters, descriptions, and annotations are stored locally in the browser.
The lightweight description beneath a capture title records capture-level context; the Notes tab retains
sequence observations alongside message and byte annotations. The compact header's **Capture length**
is the sum of every recording session from its first captured byte through its last captured byte, while
**Captured** counts all captured raw bytes, including RX and TX. Use JSON export for a
complete, re-importable backup. CSV and monitor-text exports are available for the active capture.

## Sending messages

The **Send** tab is available whenever a serial port is connected; a capture does
not need to be running. Enter complete hex bytes and either send immediately or
add the message to the timed queue. The queue and its configurable inter-message
gap are stored locally, so work is preserved across reloads.

Every send is recorded in a separate replayable history, including sends made
while capture is stopped and failed write attempts. When capture is running,
successful sends are additionally added to that capture as TX bytes. Captured
messages can also be replayed directly from the message table.

## Useful interactions

- Click any byte to attach a byte-level note.
- Use **Add note** on a row for a message-level annotation.
- Right-click a message or byte and choose **Delete** to hide it while keeping the captured data.
- Add a lightweight capture description directly beneath its title.
- In **Notes**, enter a row range to attach an observation to a specific message
  sequence.
- Use the funnel in **Message stream** to reveal filtering; wildcards such as
  `C2 ?? 5D` are supported.
- Telegram signatures that occur only once in the complete capture show their
  row ID and timestamp in orange.
- Toggle **BINARY** to see readable nibbles such as `1100·0010`.
- Hover a captured row and choose **Replay** to send its bytes again.
- **Frame changes** connects adjacent byte changes vertically whenever the
  telegrams still share at least one byte. Repeated transitions reuse the same
  frame color.
- **Collapse runs** combines only consecutive identical telegrams and shows
  their approximate cadence when the intervals are near-constant.
- Pattern analysis shows bit variance, byte vocabulary, message frequency, and
  common transitions.
