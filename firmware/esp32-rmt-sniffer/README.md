# ESP32 RMT directional sniffer

This Arduino-ESP32 3.x sketch captures the receiver output on GPIO 16 with the
ESP32 RMT peripheral and timestamps changes of the monitored device's DE signal
on GPIO 5. It decodes 9600-baud 8N1 bytes from the captured waveform and assigns
direction using DE at the middle of each character, rather than when a UART FIFO
is drained.

GPIO 4 is held low so the passive monitor transceiver remains in receive mode.
GPIO 17 is not driven. The USB serial output is 115200 baud.

Normal records retain Bus Lens's existing wire format:

```
A5 00 XX  captured byte XX while the monitored device's DE was low (RX)
A5 01 XX  captured byte XX while the monitored device's DE was high (TX)
```

Diagnostics use `A6 status detail`. Status `01` reports overwritten DE history,
`02` reports an RMT receive/setup problem, and `03` reports a rejected UART
candidate with an invalid start or stop bit. Bus Lens displays diagnostics as
capture warnings and never stores them as captured bytes.

The sketch requires Arduino-ESP32 3.x. RMT capture memory is finite; diagnostic
records must be treated as evidence that the affected capture may be incomplete.
