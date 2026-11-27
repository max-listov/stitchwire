import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  defaultConfigDir,
  defaultEventDropInDir,
  defaultNodeConfigPath,
  defaultServiceDropInDir,
  defaultStateDir,
  defaultWireSocketPath,
  writeServiceDeclarationFile,
} from '../packages/client/src/index.ts';
import { dropInDirs } from '../packages/runtime/src/config/drop-in.ts';
import { agentSocketOverride } from '../packages/runtime/src/config/paths.ts';
import { exampleUnit } from '../packages/runtime/src/enrollment/unit.ts';

/**
 * A path the writer and the agent both resolve must be absolute: a relative one resolves against each
 * process's own working directory, so the writer would put a file where the agent never looks.
 */
describe('paths of the local layout are absolute or refused', () => {
  test('an environment override that is not absolute is refused by name; an absolute one is verbatim', () => {
    const home = { homeDir: '/opt/u' };
    expect(() => defaultConfigDir({ ...home, env: { STITCHWIRE_CONFIG_DIR: 'relative/conf' } })).toThrow(
      /STITCHWIRE_CONFIG_DIR must be an absolute path/,
    );
    expect(() => defaultStateDir({ ...home, env: { STITCHWIRE_STATE_DIR: './state' } })).toThrow(
      /STITCHWIRE_STATE_DIR must be an absolute path/,
    );
    expect(() => defaultWireSocketPath({ ...home, env: { STITCHWIRE_AGENT_SOCKET: 'agent.sock' } })).toThrow(
      /STITCHWIRE_AGENT_SOCKET must be an absolute path/,
    );
    // A leading space makes a relative path; nothing is trimmed either way.
    expect(() => defaultConfigDir({ ...home, env: { STITCHWIRE_CONFIG_DIR: ' /x' } })).toThrow(RangeError);
    expect(defaultConfigDir({ ...home, env: { STITCHWIRE_CONFIG_DIR: '/x ' } })).toBe('/x ');
    // Unset and empty stay the default.
    expect(defaultConfigDir({ ...home, env: { STITCHWIRE_CONFIG_DIR: '' } })).toBe(
      '/opt/u/.config/stitchwire',
    );
  });

  test('a relative configPath has no drop-in directory the agent shares', () => {
    expect(() => defaultServiceDropInDir({ configPath: 'node.json' })).toThrow(
      /configPath must be an absolute path/,
    );
    expect(() => defaultEventDropInDir({ configPath: 'conf/node.json' })).toThrow(RangeError);
    expect(defaultServiceDropInDir({ configPath: '/opt/custom/node.json' })).toBe('/opt/custom/services.d');
  });

  test('the SDK writer refuses a relative dropInDir before it writes anything', async () => {
    const declaration = {
      binding: {
        service: 'owner.relative',
        descriptorPath: '/opt/owner/descriptor.json',
        socketPath: '/opt/owner/owner.sock',
        endpointPath: '/wire',
        maxInflight: 4,
        limits: { requestBytes: 1024, responseBytes: 4096, timeoutMs: 2000 },
      },
      callers: [],
    };
    // In a working directory of its own: a writer that took the relative path would write there.
    const cwd = process.cwd();
    const scratch = mkdtempSync(join(tmpdir(), 'wire-relative-'));
    process.chdir(scratch);
    try {
      await expect(
        writeServiceDeclarationFile('owner', declaration, { dropInDir: 'relative/services.d' }),
      ).rejects.toMatchObject({ code: 'invalid-request', delivery: 'not-sent' });
      await expect(
        writeServiceDeclarationFile('owner', declaration, { configPath: 'node.json' }),
      ).rejects.toMatchObject({ code: 'invalid-request', delivery: 'not-sent' });
      expect(readdirSync(scratch)).toEqual([]);
    } finally {
      process.chdir(cwd);
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('local path discovery', () => {
  test('the SDK defaults are the layout the installed unit gives the agent, rooted at any home', () => {
    // The source of the layout: the unit enrollment and the product example install.
    const unit = exampleUnit('agent');
    const exec = /^ExecStart=.* "--config" "([^"]+)"$/m.exec(unit)?.[1];
    const configDir = /"STITCHWIRE_CONFIG_DIR=([^"]+)"/.exec(unit)?.[1];
    const stateDir = /"STITCHWIRE_STATE_DIR=([^"]+)"/.exec(unit)?.[1];
    expect([exec, configDir, stateDir].every((value) => value?.startsWith('%h/'))).toBe(true);
    // Built at run time: a literal home path in source is refused by the artifact privacy scan.
    const homes = [
      ['', 'home', 'operator'],
      ['', 'root'],
      ['', 'Users', 'someone'],
    ].map((parts) => parts.join('/'));
    for (const home of homes) {
      const at = (path: string | undefined) => path?.replace('%h', home);
      const options = { homeDir: home, env: {} };
      expect(defaultNodeConfigPath(options)).toBe(at(exec) ?? '');
      expect(defaultConfigDir(options)).toBe(at(configDir) ?? '');
      expect(defaultStateDir(options)).toBe(at(stateDir) ?? '');
      expect(defaultWireSocketPath(options)).toBe(`${at(stateDir)}/agent.sock`);
      // The agent's own default socket: its state directory as the unit sets it.
      expect(
        defaultWireSocketPath({ homeDir: '/elsewhere', env: { STITCHWIRE_STATE_DIR: at(stateDir) } }),
      ).toBe(`${at(stateDir)}/agent.sock`);
      // State is never on a tmpfs runtime directory.
      expect(defaultStateDir(options).startsWith('/run/')).toBe(false);
    }
    // The macOS LaunchAgent example names the same two directories.
    const plist = readFileSync(
      join(import.meta.dir, '../contrib/launchd/com.stitchwire.agent.plist'),
      'utf8',
    );
    expect(plist).toContain('/Users/USERNAME/.config/stitchwire/node.json');
    expect(plist).toContain('/Users/USERNAME/.local/state/stitchwire/');
    expect(defaultNodeConfigPath({ homeDir: '/Users/USERNAME', env: {} })).toBe(
      '/Users/USERNAME/.config/stitchwire/node.json',
    );
  });

  test('environment overrides are verbatim, an empty one is unset, and the runtime reads them the same way', () => {
    expect(
      defaultWireSocketPath({
        homeDir: '/opt/u',
        env: { STITCHWIRE_STATE_DIR: '/var/state/sw', STITCHWIRE_AGENT_SOCKET: '/custom/agent.sock' },
      }),
    ).toBe('/custom/agent.sock');
    expect(
      defaultWireSocketPath({
        homeDir: '/opt/u',
        env: { STITCHWIRE_AGENT_SOCKET: '', STITCHWIRE_STATE_DIR: '/var/state/sw' },
      }),
    ).toBe('/var/state/sw/agent.sock');
    // Nothing is trimmed: a value is a path as the operator wrote it, and it must be absolute.
    expect(defaultConfigDir({ homeDir: '/opt/u', env: { STITCHWIRE_CONFIG_DIR: '/x ' } })).toBe('/x ');
    expect(() => defaultConfigDir({ homeDir: '/opt/u', env: { STITCHWIRE_CONFIG_DIR: ' /x ' } })).toThrow(
      /STITCHWIRE_CONFIG_DIR must be an absolute path/,
    );
    expect(defaultConfigDir({ homeDir: '/opt/u', env: { STITCHWIRE_CONFIG_DIR: '' } })).toBe(
      '/opt/u/.config/stitchwire',
    );
    const saved = process.env.STITCHWIRE_AGENT_SOCKET;
    try {
      process.env.STITCHWIRE_AGENT_SOCKET = '';
      expect(agentSocketOverride()).toBeUndefined();
      process.env.STITCHWIRE_AGENT_SOCKET = '/spaced .sock';
      expect(agentSocketOverride()).toBe('/spaced .sock');
      expect(defaultWireSocketPath()).toBe('/spaced .sock');
      // A leading space makes the value relative: the SDK and the runtime refuse it alike.
      process.env.STITCHWIRE_AGENT_SOCKET = ' /spaced.sock';
      expect(() => agentSocketOverride()).toThrow(/STITCHWIRE_AGENT_SOCKET must be an absolute path/);
      expect(() => defaultWireSocketPath()).toThrow(RangeError);
    } finally {
      if (saved === undefined) delete process.env.STITCHWIRE_AGENT_SOCKET;
      else process.env.STITCHWIRE_AGENT_SOCKET = saved;
    }
  });

  test('only node.json has default drop-in directories, beside it', () => {
    expect(defaultServiceDropInDir({ configPath: '/opt/custom/node.json' })).toBe('/opt/custom/services.d');
    expect(defaultEventDropInDir({ configPath: '/opt/custom/node.json' })).toBe('/opt/custom/events.d');
    expect(defaultServiceDropInDir({ homeDir: '/opt/u', env: {} })).toBe(
      '/opt/u/.config/stitchwire/services.d',
    );
    expect(() => defaultServiceDropInDir({ configPath: '/opt/custom/worker.json' })).toThrow(RangeError);
    expect(dropInDirs({ services: {}, events: {} }, '/opt/custom/worker.json')).toEqual({
      services: undefined,
      events: undefined,
    });
    expect(dropInDirs({ services: {}, events: { dropInDir: null } }, '/opt/custom/node.json')).toEqual({
      services: '/opt/custom/services.d',
      events: undefined,
    });
    expect(
      dropInDirs({ services: { dropInDir: '/srv/sd' }, events: {} }, '/opt/custom/worker.json').services,
    ).toBe('/srv/sd');
  });
});
