/**
 * Preloaded into a command that must judge files as if it ran as another user than the one who owns
 * them — an operator's root over an agent of this user — without root: this process's uid, as the
 * drop-in policy reads it, is one more than the real one.
 */
const own = process.getuid?.bind(process);
if (own !== undefined) process.getuid = () => own() + 1;
