/**
 * Prints a line that was never JSON. A negative control for unrecoverability:
 * the producer broke, but retrying still makes sense here — it may have broken only once.
 */
process.stdout.write('this was never json\n');

export {};
