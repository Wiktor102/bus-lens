# Agent guidance

- Pay close attention to click handlers. Do not pass action functions directly to React event props when they interpret arguments; wrap them so the event object is not forwarded.
- When state updates capture values from an event, read the event value before calling the setter. Do not access `event` or `event.currentTarget.value` inside a functional state-update callback; see #30 for reference.
