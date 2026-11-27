import { ownEntry } from '../json.ts';
import type { CallerArgsPolicy } from '../config/profiles.ts';

function callerArgBytes(args: string[]): number {
  return Buffer.byteLength(args.join('\0'));
}

/** Validate every caller-controlled argument before an owner executable is admitted or spawned. */
export function validateCallerArgs(args: string[], policy: CallerArgsPolicy): string | null {
  if (policy.mode === 'none') return args.length === 0 ? null : 'profile does not accept caller arguments';

  if (policy.mode === 'append') {
    if (args.length > policy.maxCount) return `caller argument count exceeds ${policy.maxCount}`;
    if (callerArgBytes(args) > policy.maxBytes) return `caller arguments exceed ${policy.maxBytes} bytes`;
    if (policy.allowedValues !== undefined && args.some((arg) => !policy.allowedValues?.includes(arg))) {
      return 'caller argument is outside allowedValues';
    }
    return null;
  }

  if (args.length % 2 !== 0) return 'named caller options must be flag/value pairs';
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index] ?? '';
    const value = args[index + 1] ?? '';
    const option = ownEntry(policy.options, name);
    if (option === undefined) return `caller option '${name}' is not allowed`;
    if (seen.has(name)) return `caller option '${name}' may appear only once`;
    seen.add(name);

    if (option.type === 'opaque') {
      const bytes = Buffer.byteLength(value);
      if (!/^[A-Za-z0-9_-]+$/.test(value)) return `caller option '${name}' must be an opaque token`;
      if (bytes < option.minBytes || bytes > option.maxBytes) {
        return `caller option '${name}' must contain ${option.minBytes}..${option.maxBytes} bytes`;
      }
      if (option.prefix !== undefined && !value.startsWith(option.prefix)) {
        return `caller option '${name}' has the wrong opaque-token prefix`;
      }
      continue;
    }

    if (!/^(0|[1-9][0-9]*)$/.test(value)) return `caller option '${name}' must be a canonical integer`;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < option.min || number > option.max) {
      return `caller option '${name}' must be between ${option.min} and ${option.max}`;
    }
  }

  for (const [name, option] of Object.entries(policy.options)) {
    if (option.required && !seen.has(name)) return `caller option '${name}' is required`;
  }
  return null;
}
