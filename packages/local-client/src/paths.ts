import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * The one local layout Stitchwire installs, on macOS and Linux alike: configuration under
 * `<home>/.config/stitchwire`, the agent's door and journals under `<home>/.local/state/stitchwire`.
 * A system unit runs the same layout under its own user's home; there is no second, system-wide one.
 */
export interface WirePathOptions {
  /** Home directory the layout is rooted in; defaults to `os.homedir()`. */
  homeDir?: string;
  /** Environment map inspected at call time; defaults to `process.env`. */
  env?: Readonly<Record<string, string | undefined>>;
}

export interface WireDropInPathOptions extends WirePathOptions {
  /** Explicit absolute path to `node.json`; when supplied, drop-in directories resolve beside it. */
  configPath?: string;
}

/** The configuration file whose directory also holds the default drop-in directories. */
export const NODE_CONFIG_FILE = 'node.json';

/**
 * A path named for the agent's layout, which more than one process resolves: it must be absolute,
 * since a relative one would resolve against each process's own working directory — the writer's
 * and the agent's differ. A relative path is a `RangeError` naming `what`.
 */
export function absolutePath(what: string, path: string): string {
  if (!isAbsolute(path))
    throw new RangeError(
      `${what} must be an absolute path, not ${JSON.stringify(path.slice(0, 256))}: a relative one resolves against each process's own working directory`,
    );
  return path;
}

/**
 * A path an operator set in the environment: its value verbatim, or `undefined` when the variable is
 * unset or empty. Empty counts as unset, as in the XDG base-directory convention; nothing is trimmed,
 * and a value that is not an absolute path is refused (`absolutePath`).
 */
export function envPath(
  name: 'STITCHWIRE_CONFIG_DIR' | 'STITCHWIRE_STATE_DIR' | 'STITCHWIRE_AGENT_SOCKET',
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const value = env[name];
  return value === undefined || value === '' ? undefined : absolutePath(name, value);
}

function home(options: WirePathOptions): string {
  return options.homeDir === undefined || options.homeDir === '' ? homedir() : options.homeDir;
}

/** Default directory holding `node.json` and drop-in subdirectories, evaluated at call time. */
export function defaultConfigDir(options: WirePathOptions = {}): string {
  return envPath('STITCHWIRE_CONFIG_DIR', options.env) ?? join(home(options), '.config', 'stitchwire');
}

/** Default directory holding `agent.sock` and the agent's local journals, evaluated at call time. */
export function defaultStateDir(options: WirePathOptions = {}): string {
  return envPath('STITCHWIRE_STATE_DIR', options.env) ?? join(home(options), '.local', 'state', 'stitchwire');
}

/**
 * Default local Unix door socket path (`agent.sock`), evaluated at call time.
 * Precedence: `STITCHWIRE_AGENT_SOCKET` > `STITCHWIRE_STATE_DIR/agent.sock` > `<home>/.local/state/stitchwire/agent.sock`.
 * An agent whose `node.json` names another `agentSocket` is reached only at that path.
 */
export function defaultWireSocketPath(options: WirePathOptions = {}): string {
  return envPath('STITCHWIRE_AGENT_SOCKET', options.env) ?? join(defaultStateDir(options), 'agent.sock');
}

/** Default `node.json` path, evaluated at call time (`STITCHWIRE_CONFIG_DIR/node.json` > default). */
export function defaultNodeConfigPath(options: WirePathOptions = {}): string {
  return join(defaultConfigDir(options), NODE_CONFIG_FILE);
}

/**
 * The drop-in directory an agent reads by default for the configuration at `configPath`, or
 * `undefined` when that configuration has none. Only a file named `node.json` has default drop-in
 * directories, beside it: two configurations in one directory never share one. An agent started from
 * another file reads drop-in declarations only where its `dropInDir` names them.
 */
export function dropInDirBeside(configPath: string, kind: 'services.d' | 'events.d'): string | undefined {
  const absolute = resolve(configPath);
  return basename(absolute) === NODE_CONFIG_FILE ? join(dirname(absolute), kind) : undefined;
}

function defaultDropInDir(options: WireDropInPathOptions, kind: 'services.d' | 'events.d'): string {
  const configPath =
    options.configPath === undefined || options.configPath === ''
      ? defaultNodeConfigPath(options)
      : absolutePath('configPath', options.configPath);
  const dir = dropInDirBeside(configPath, kind);
  if (dir === undefined)
    throw new RangeError(
      `${configPath} has no default drop-in directory: only ${NODE_CONFIG_FILE} has one; pass the dropInDir its agent reads`,
    );
  return dir;
}

/** Default drop-in directory for owner service declarations (`services.d` beside `node.json`). */
export function defaultServiceDropInDir(options: WireDropInPathOptions = {}): string {
  return defaultDropInDir(options, 'services.d');
}

/** Default drop-in directory for owner topic descriptors (`events.d` beside `node.json`). */
export function defaultEventDropInDir(options: WireDropInPathOptions = {}): string {
  return defaultDropInDir(options, 'events.d');
}
