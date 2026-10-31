import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

type Entity = { id: string; updatedAt: string };

/** A tiny JSON-file collection; all reads and writes go through one queue so concurrent updates don't clobber each other. */
export function createJsonStore<T extends Entity>(file: string) {
  let queue: Promise<unknown> = Promise.resolve();
  const serialize = <R>(fn: () => Promise<R>): Promise<R> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  async function readAll(): Promise<T[]> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async function writeAll(items: T[]) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(items, null, 2));
  }

  return {
    list: (filter: (item: T) => boolean = () => true) => serialize(async () => (await readAll()).filter(filter)),
    get: (id: string) => serialize(async () => (await readAll()).find((item) => item.id === id)),
    create: (item: T) =>
      serialize(async () => {
        await writeAll([...(await readAll()), item]);
        return item;
      }),
    update: (id: string, patch: Partial<Omit<T, "id" | "createdAt">>) =>
      serialize(async () => {
        const items = await readAll();
        const index = items.findIndex((item) => item.id === id);
        if (index === -1) return undefined;
        items[index] = { ...items[index], ...patch, updatedAt: new Date().toISOString() };
        await writeAll(items);
        return items[index];
      }),
    remove: (id: string) =>
      serialize(async () => {
        const items = await readAll();
        const remaining = items.filter((item) => item.id !== id);
        await writeAll(remaining);
        return remaining.length !== items.length;
      }),
  };
}
