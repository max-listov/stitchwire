import { describe, expect, test } from 'bun:test';
import { assertSocketIoPresent } from './standalone-socket-io.ts';

describe('standalone Socket.IO dependency gate', () => {
  test('package names in errors do not prove bundled implementations', () => {
    expect(() => assertSocketIoPresent('needs socket.io-client and socket.io')).toThrow(
      'socket.io-client, socket.io',
    );
  });

  test('client code without server code is incomplete', () => {
    expect(() => assertSocketIoPresent('/* engine.io-client */')).toThrow('socket.io');
  });

  test('server code without client code is incomplete', () => {
    expect(() => assertSocketIoPresent('/* socket.io-parser */')).toThrow('socket.io-client');
  });

  test('both implementations may coexist with the unused framework default loader', () => {
    expect(() =>
      assertSocketIoPresent('/* engine.io-client */ /* socket.io-parser */ import(SOCKET_IO_CLIENT)'),
    ).not.toThrow();
  });
});
