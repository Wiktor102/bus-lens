# Agent guidance

- Pay close attention to click handlers. Do not pass action functions directly to React event props when they interpret arguments; wrap them so the event object is not forwarded.
- When a state update needs an event value, read it into a local variable before calling the setter. Do not access `event` or `event.currentTarget.value` inside a functional state-update callback, because React may run that callback after the event has finished and `currentTarget` has been cleared.
