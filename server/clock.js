// One place for "now" so tests and the demo can move time without touching Date globally.
let offsetMs = 0

export const now = () => Date.now() + offsetMs
export const advanceClock = (ms) => { offsetMs += ms }
export const resetClock = () => { offsetMs = 0 }
