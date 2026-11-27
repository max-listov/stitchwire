/**
 * The one shape of an installed Stitchwire process under systemd.
 *
 * The example units and enrollment's installation are the same unit, so its text has one renderer:
 * a deployment that updates a node in place finds the runtime, config and unit where the example
 * puts them. A path is either a literal or a `%h` specifier with a literal tail: only the literal
 * part is escaped, which is what lets the example keep `%h` while an installation writes absolute
 * paths through the same code. There is no mount-namespace sandboxing (`ProtectSystem`,
 * `PrivateTmp`): the shape serves user units, where those need unprivileged user namespaces, and an
 * agent runs the binaries its allowlist names wherever they are installed.
 */

import { join } from 'node:path';
import { defaultConfigDir, defaultNodeConfigPath, defaultStateDir } from '../../../local-client/src/paths.ts';

/** The canonical agent unit: the example's name, and the default of an enrollment installation. */
export const AGENT_UNIT = 'stitchwire-agent.service';

export type UnitPath = string | { readonly home: '%h'; readonly rest: string };
type UnitScope = 'system' | 'user';
type UnitLayout = {
  readonly role: 'agent' | 'broker';
  readonly scope: UnitScope;
  readonly bun: UnitPath;
  readonly runtime: UnitPath;
  readonly config: UnitPath;
  readonly configDir: UnitPath;
  readonly stateDir: UnitPath;
};

/** systemd expands percent specifiers even inside quotes; ExecStart also expands `$` references. */
function quote(prefix: string, path: UnitPath, exec: boolean): string {
  const literal = (text: string) => {
    const quoted = text.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%');
    return exec ? quoted.split('$').join('$$') : quoted;
  };
  return typeof path === 'string'
    ? `"${literal(prefix + path)}"`
    : `"${literal(prefix)}${path.home}${literal(path.rest)}"`;
}

export function renderUnit(layout: UnitLayout): string {
  const exec = [layout.bun, layout.runtime, layout.role, '--config', layout.config].map((part) =>
    quote('', part, true),
  );
  const environment = [
    quote('STITCHWIRE_CONFIG_DIR=', layout.configDir, false),
    quote('STITCHWIRE_STATE_DIR=', layout.stateDir, false),
  ];
  return [
    '[Unit]',
    `Description=Stitchwire ${layout.role}`,
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=exec',
    `ExecStart=${exec.join(' ')}`,
    `Environment=${environment.join(' ')}`,
    'Restart=always',
    'RestartSec=2',
    'UMask=0077',
    'NoNewPrivileges=true',
    'TimeoutStopSec=30',
    '',
    '[Install]',
    `WantedBy=${layout.scope === 'system' ? 'multi-user.target' : 'default.target'}`,
    '',
  ].join('\n');
}

/**
 * The product example: a user unit under the installing user's home. Its configuration and state
 * directories are the client SDK's default layout rooted at `%h`, so the paths a client derives and
 * the paths the unit gives the process are one formula.
 */
export function exampleUnit(role: UnitLayout['role']): string {
  const home = (rest: string): UnitPath => ({ home: '%h', rest });
  const layout = { homeDir: '%h', env: {} };
  const underHome = (path: string): UnitPath => home(path.slice('%h'.length));
  return renderUnit({
    role,
    scope: 'user',
    bun: home('/.bun/bin/bun'),
    runtime: home('/.local/bin/stitchwire'),
    config: underHome(
      role === 'agent' ? defaultNodeConfigPath(layout) : join(defaultConfigDir(layout), 'broker.json'),
    ),
    configDir: underHome(defaultConfigDir(layout)),
    stateDir: underHome(defaultStateDir(layout)),
  });
}
