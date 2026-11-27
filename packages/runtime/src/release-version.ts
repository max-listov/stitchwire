import manifest from '../../../package.json' with { type: 'json' };

/** Runtime identity, independent of the local door and optional SDK. */
export const RELEASE_VERSION: string = manifest.version;
