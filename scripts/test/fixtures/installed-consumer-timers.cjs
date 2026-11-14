// Loaded only by fixtures into the real supervisor; production has no timer knob.
const timeout = setTimeout
global.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 12000 ? 250 : ms, ...args)
