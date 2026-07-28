# Bus Lens

A local-first RS-485 capture and protocol-analysis workbench. It uses the browser's
Web Serial API, so run it in a current Chromium-based browser (Chrome or Edge).

## Run

Right-click `start.ps1` and choose **Run with PowerShell**, or run:

```powershell
cd D:\Dokumenty\dom\wentylacja\rs485-lab
.\start.ps1
```

If script execution is restricted, `npm start` is an equivalent option when
Node.js is available.

Open the local address printed in the terminal. It normally uses
`http://127.0.0.1:4173`; if that port is occupied, Bus Lens automatically tries
the next available port.

## Capture modes

- **Raw bytes** groups incoming bytes by the configured frame size (3 by default).
- **Text / Arduino monitor** parses timestamped lines such as
  `12:39:07.009 -> C2 08 5D`.

Capture context, messages, parameters, and notes are stored locally in the browser.
Use JSON export for a complete, re-importable backup. CSV and monitor-text exports
are available for the active capture.

## Useful interactions

- Click any byte to attach a byte-level note.
- Use **Add note** on a row for a message-level annotation.
- In **Notes**, choose **Message sequence** and enter a row range to attach an
  observation to a specific sequence.
- Use wildcards in stream filtering, for example `C2 ?? 5D`.
- Toggle **BINARY** to see readable nibbles such as `1100·0010`.
- Pattern analysis shows bit variance, byte vocabulary, message frequency, and
  common transitions.
