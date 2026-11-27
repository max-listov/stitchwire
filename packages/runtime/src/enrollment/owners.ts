import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  type EnrollmentDescriptor,
  EnrollmentDescriptorSchema,
} from '../../../contracts/src/enrollment/request.ts';
import { ownEntry } from '../json.ts';
import { EnrollmentError } from './failure.ts';
import { ENROLLMENT_REQUEST_BYTES, readValue, writePrivate } from './files.ts';
import { enrollmentRoot } from './journal.ts';

const OwnersSchema = z.record(
  z.string(),
  z.strictObject({
    /** What the owner last asked to bind. */
    descriptors: z.array(EnrollmentDescriptorSchema),
    /** What the configuration may still hold for it, until a read-back confirms the request. */
    managed: z.array(EnrollmentDescriptorSchema),
    attached: z.boolean(),
  }),
);
type Owners = z.infer<typeof OwnersSchema>;

/** Keep both kinds at the same path during an interrupted kind change until config confirms it. */
function union(bindings: EnrollmentDescriptor[]): EnrollmentDescriptor[] {
  return [...new Map(bindings.map((binding) => [`${binding.kind}:${binding.path}`, binding])).values()];
}

/**
 * Which owner bound which descriptor path of one node configuration. The ledger belongs to the
 * configuration, not to a request: it is read fresh and written only under the configuration lock.
 */
export class OwnersLedger {
  private constructor(
    private readonly root: string,
    private readonly owners: Owners,
  ) {}

  static read(config: string): OwnersLedger {
    const root = enrollmentRoot(config);
    const file = join(root, 'owners.json');
    return new OwnersLedger(
      root,
      existsSync(file) ? readValue(file, OwnersSchema, ENROLLMENT_REQUEST_BYTES) : {},
    );
  }

  knows(owner: string): boolean {
    return ownEntry(this.owners, owner) !== undefined;
  }

  attached(owner: string): boolean | undefined {
    return ownEntry(this.owners, owner)?.attached;
  }

  /** Whether this owner may still hold the path in the configuration, under either parser kind. */
  manages(owner: string, path: string, kind?: EnrollmentDescriptor['kind']): boolean {
    const managed = ownEntry(this.owners, owner)?.managed ?? [];
    return managed.some((entry) => entry.path === path && (kind === undefined || entry.kind === kind));
  }

  /** Whether any owner holds the path; an unclaimed binding was written without enrollment. */
  claimed(path: string): boolean {
    return Object.keys(this.owners).some((id) => this.manages(id, path));
  }

  managedByAnother(owner: string, path: string): boolean {
    return Object.keys(this.owners).some((id) => id !== owner && this.manages(id, path));
  }

  /** Everything the owner asked for or may still hold: the whole scope a detach must withdraw. */
  bindings(owner: string): EnrollmentDescriptor[] {
    const entry = ownEntry(this.owners, owner);
    return union([...(entry?.descriptors ?? []), ...(entry?.managed ?? [])]);
  }

  /** Intent precedes config: a crash after either write can be reconciled from the same owner. */
  set(owner: string, descriptors: EnrollmentDescriptor[], attached: boolean): void {
    const managed = union([...(ownEntry(this.owners, owner)?.managed ?? []), ...descriptors]);
    this.owners[owner] = { descriptors, managed, attached };
    this.save();
  }

  /** The configuration was read back holding exactly the request: older claims are released. */
  confirm(owner: string): void {
    const entry = ownEntry(this.owners, owner);
    if (entry === undefined) throw new EnrollmentError('state-invalid');
    entry.managed = entry.attached ? entry.descriptors : [];
    this.save();
  }

  private save(): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    writePrivate(join(this.root, 'owners.json'), this.owners);
  }
}
