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

## Capture modes

The serial input is a raw binary stream, compatible with ESP32 `Serial.write()`.
Every byte is stored with its own receive timestamp before any framing is applied.

Message framing is a preview setting and can be changed without recapturing:

- **Length** groups the raw stream into a configurable number of bytes.
- **Sectioned length** lets one capture use different frame lengths across raw-byte
  sections; each section starts at a selected raw-byte position.
- **Marker** starts or ends a message at a configurable hex byte sequence.
- **Time gap** starts a new message after a configurable idle interval.

Marker mode leaves the preview empty until a marker is configured and found; the
raw byte stream remains preserved while the framing rule is being set.

Because the timestamp is recorded when a Web Serial read delivers a byte, multiple
bytes delivered in the same browser read may have effectively identical times.

Capture context, messages, parameters, descriptions, and annotations are stored locally in the browser.
The lightweight description beneath a capture title records capture-level context; the Notes tab retains
sequence observations alongside message and byte annotations. The compact header's **Capture length**
is the sum of every recording session from its first received byte through its last received byte, while
**Captured** counts received raw bytes only and excludes transmitted (TX) bytes. Use JSON export for a
complete, re-importable backup. CSV and monitor-text exports are available for the active capture.

The connection badge shows an OS serial port label such as `COM4` when the host runtime provides one.
Standard browser Web Serial does not expose OS-assigned COM numbers, so Chromium displays the connected
USB device's `VID:PID` identity instead.

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
