#include <Arduino.h>
#include "esp32-hal-rmt.h"

// Bus Lens directional RS-485 sniffer for Arduino-ESP32 3.x.
//
// RX2_PIN is connected to the receiver output of the passive RS-485 monitor.
// SOURCE_DE is connected to the monitored device's driver-enable signal.
// DE_RE_PIN keeps the monitor transceiver in receive mode. TX2_PIN is retained
// in the pinout for wiring compatibility but is deliberately not driven.

#define RX2_PIN 16
#define TX2_PIN 17
#define DE_RE_PIN 4
#define SOURCE_DE 5

constexpr uint32_t BUS_BAUD = 9600;
constexpr uint32_t RMT_HZ = 1000000;       // one tick is one microsecond
constexpr uint16_t RMT_IDLE_TICKS = 2200;  // a little over two 8N1 characters
constexpr size_t RMT_SYMBOL_CAPACITY = 256;
constexpr size_t DE_EDGE_CAPACITY = 256;

constexpr uint8_t REC_BYTE = 0xA5;
constexpr uint8_t REC_STATUS = 0xA6;
constexpr uint8_t STATUS_DE_OVERFLOW = 0x01;
constexpr uint8_t STATUS_RMT_OVERFLOW = 0x02;
constexpr uint8_t STATUS_FRAMING_ERROR = 0x03;

struct DeEdge {
  uint32_t at;
  uint8_t level;
};

struct Pulse {
  uint32_t startTick;
  uint16_t duration;
  uint8_t level;
};

static rmt_data_t rmtSymbols[RMT_SYMBOL_CAPACITY];
static DeEdge deEdges[DE_EDGE_CAPACITY];
static volatile uint32_t deWriteSequence = 0;
static volatile bool deOverflow = false;
static volatile uint32_t deReadSequence = 0;
static uint8_t initialDeLevel = 0;

static bool timeAtOrBefore(uint32_t candidate, uint32_t target) {
  return static_cast<int32_t>(target - candidate) >= 0;
}

void IRAM_ATTR onDeChange() {
  const uint32_t sequence = deWriteSequence;
  deEdges[sequence % DE_EDGE_CAPACITY] = {
    static_cast<uint32_t>(micros()),
    static_cast<uint8_t>(digitalRead(SOURCE_DE) != 0)
  };
  deWriteSequence = sequence + 1;
  if (deWriteSequence - deReadSequence > DE_EDGE_CAPACITY) {
    deOverflow = true;
  }
}

static void writeByteRecord(uint8_t value, bool transmitting) {
  const uint8_t record[3] = {REC_BYTE, static_cast<uint8_t>(transmitting), value};
  Serial.write(record, sizeof(record));
}

static void writeStatus(uint8_t status, uint8_t detail = 0) {
  const uint8_t record[3] = {REC_STATUS, status, detail};
  Serial.write(record, sizeof(record));
}

static uint8_t deLevelAt(uint32_t timestamp) {
  noInterrupts();
  uint32_t writeSequence = deWriteSequence;
  bool overflowed = deOverflow || writeSequence - deReadSequence > DE_EDGE_CAPACITY;
  if (overflowed) {
    deReadSequence = writeSequence > DE_EDGE_CAPACITY ? writeSequence - DE_EDGE_CAPACITY : 0;
    deOverflow = false;
  }
  interrupts();

  if (overflowed) writeStatus(STATUS_DE_OVERFLOW);

  uint8_t level = initialDeLevel;
  uint32_t sequence = deReadSequence;
  while (sequence < writeSequence) {
    const DeEdge edge = deEdges[sequence % DE_EDGE_CAPACITY];
    if (!timeAtOrBefore(edge.at, timestamp)) break;
    level = edge.level;
    sequence++;
  }

  // Edges older than the queried byte can no longer affect a later byte. Keep
  // the last consumed level as the new history baseline.
  if (sequence != deReadSequence) {
    initialDeLevel = level;
    deReadSequence = sequence;
  }
  return level;
}

static uint8_t levelAtTick(const Pulse *pulses, size_t pulseCount, uint32_t tick) {
  for (size_t i = 0; i < pulseCount; i++) {
    const uint32_t end = pulses[i].startTick + pulses[i].duration;
    if (tick >= pulses[i].startTick && tick < end) return pulses[i].level;
  }
  return 1; // RS-485 UART is idle high
}

static void decodeCapture(size_t symbolCount, uint32_t completedAt) {
  Pulse pulses[RMT_SYMBOL_CAPACITY * 2];
  size_t pulseCount = 0;
  uint32_t totalTicks = 0;

  for (size_t i = 0; i < symbolCount; i++) {
    const rmt_data_t symbol = rmtSymbols[i];
    if (symbol.duration0) pulses[pulseCount++] = {totalTicks, symbol.duration0, static_cast<uint8_t>(symbol.level0)};
    totalTicks += symbol.duration0;
    if (symbol.duration1) pulses[pulseCount++] = {totalTicks, symbol.duration1, static_cast<uint8_t>(symbol.level1)};
    totalTicks += symbol.duration1;
  }
  if (!pulseCount || !totalTicks) return;

  // rmtRead returns immediately after the terminal idle interval. Anchoring
  // the waveform at completion makes its timing comparable to micros() values
  // recorded by the DE ISR. Classification uses the middle of the character,
  // leaving roughly half a character of margin from a normal DE-fall edge.
  const uint32_t captureStartedAt = completedAt - totalTicks;
  const uint32_t bitTicks = (RMT_HZ + BUS_BAUD / 2) / BUS_BAUD;
  uint32_t scanTick = 0;

  while (scanTick + bitTicks * 10 <= totalTicks) {
    bool foundStart = false;
    uint32_t startTick = 0;
    for (size_t i = 0; i < pulseCount; i++) {
      if (pulses[i].startTick < scanTick) continue;
      const bool falling = pulses[i].level == 0 &&
        (i == 0 || pulses[i - 1].level == 1);
      if (falling) {
        startTick = pulses[i].startTick;
        foundStart = true;
        break;
      }
    }
    if (!foundStart || startTick + bitTicks * 10 > totalTicks) break;

    // Reject data-bit falling edges by requiring a low start-bit midpoint and
    // a high stop-bit midpoint. After a rejection, continue at the next edge.
    if (levelAtTick(pulses, pulseCount, startTick + bitTicks / 2) != 0 ||
        levelAtTick(pulses, pulseCount, startTick + bitTicks * 9 + bitTicks / 2) != 1) {
      writeStatus(STATUS_FRAMING_ERROR);
      scanTick = startTick + 1;
      continue;
    }

    uint8_t value = 0;
    for (uint8_t bit = 0; bit < 8; bit++) {
      if (levelAtTick(pulses, pulseCount, startTick + bitTicks * (bit + 1) + bitTicks / 2)) {
        value |= static_cast<uint8_t>(1U << bit);
      }
    }
    const uint32_t midpoint = captureStartedAt + startTick + bitTicks * 5;
    writeByteRecord(value, deLevelAt(midpoint) != 0);
    scanTick = startTick + bitTicks * 10;
  }
}

void setup() {
  Serial.begin(115200);
  pinMode(DE_RE_PIN, OUTPUT);
  digitalWrite(DE_RE_PIN, LOW);
  pinMode(RX2_PIN, INPUT_PULLUP);
  pinMode(SOURCE_DE, INPUT);
  initialDeLevel = static_cast<uint8_t>(digitalRead(SOURCE_DE) != 0);
  attachInterrupt(digitalPinToInterrupt(SOURCE_DE), onDeChange, CHANGE);

  if (!rmtInit(RX2_PIN, RMT_RX_MODE, RMT_MEM_NUM_BLOCKS_4, RMT_HZ) ||
      !rmtSetRxMinThreshold(RX2_PIN, 2) ||
      !rmtSetRxMaxThreshold(RX2_PIN, RMT_IDLE_TICKS)) {
    while (true) {
      writeStatus(STATUS_RMT_OVERFLOW, 0xFF);
      delay(1000);
    }
  }
}

void loop() {
  size_t symbolCount = RMT_SYMBOL_CAPACITY;
  if (!rmtRead(RX2_PIN, rmtSymbols, &symbolCount, RMT_WAIT_FOR_EVER)) {
    writeStatus(STATUS_RMT_OVERFLOW);
    return;
  }
  const uint32_t completedAt = micros();
  if (symbolCount == RMT_SYMBOL_CAPACITY) writeStatus(STATUS_RMT_OVERFLOW, 1);
  decodeCapture(symbolCount, completedAt);
}
