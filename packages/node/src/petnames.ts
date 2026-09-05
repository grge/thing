/**
 * Petnames on disk.
 *
 * Kept **in the store's own directory**, because a petname is a property of the
 * client and the directory is what the client is: its spaces, its keys, and its
 * names. Splitting them would put one client's state in two places, and backing
 * up the directory would silently lose the names.
 *
 * Nothing here is replicated. §5.5: every peer names spaces for itself.
 */
import type { PetnameStore, SpaceId } from '@thing/store';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class FilePetnames implements PetnameStore {
  constructor(private readonly dir: string) {}

  private get path(): string {
    return join(this.dir, 'petnames.json');
  }

  async all(): Promise<ReadonlyMap<string, SpaceId>> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8'));
      if (typeof raw !== 'object' || raw === null) return new Map();
      const out = new Map<string, SpaceId>();
      for (const [name, id] of Object.entries(raw)) {
        if (typeof id === 'string') out.set(name, id);
      }
      return out;
    } catch {
      // No file yet, or one this version cannot read. Either way there are no
      // petnames, which is a fine state to be in.
      return new Map();
    }
  }

  async set(name: string, space: SpaceId): Promise<void> {
    const all = new Map(await this.all());
    all.set(name, space);
    await this.save(all);
  }

  async remove(name: string): Promise<void> {
    const all = new Map(await this.all());
    all.delete(name);
    await this.save(all);
  }

  private async save(all: ReadonlyMap<string, SpaceId>): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.path, `${JSON.stringify(Object.fromEntries(all), null, 2)}\n`);
  }
}
