export interface DeviceStorageBridge {
  read(key: string): Promise<{ version: number; value: unknown }>;
  write(key: string, value: unknown, expectedVersion: number): Promise<boolean>;
}
declare global {
  interface Window { todograph?: { isElectron: boolean; deviceStorage: DeviceStorageBridge } }
}
interface WireRecord { json: unknown; blobs: Array<{ path: string[]; type: string; base64: string }> }

async function encode(value: unknown): Promise<WireRecord> {
  const blobs: WireRecord['blobs'] = [];
  const visit = async (value: unknown, path: string[]): Promise<unknown> => {
    if (value instanceof Blob) {
      const bytes = new Uint8Array(await value.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      blobs.push({ path, type: value.type, base64: btoa(binary) }); return null;
    }
    if (Array.isArray(value)) return Promise.all(value.map((item, index) => visit(item, [...path, String(index)])));
    if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await visit(item, [...path, key])])));
    return value;
  };
  return { json: await visit(value, []), blobs };
}

function decode(value: unknown): unknown {
  const wire = value as WireRecord;
  const json = wire.json;
  for (const blob of wire.blobs) {
    let target = json as Record<string, unknown>;
    for (const key of blob.path.slice(0, -1)) {
      if (!Object.hasOwn(target, key)) throw new Error('本地图片记录无效');
      target = target[key] as Record<string, unknown>;
    }
    const binary = atob(blob.base64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    Object.defineProperty(target, blob.path.at(-1)!, { value: new Blob([bytes], { type: blob.type }), enumerable: true, writable: true, configurable: true });
  }
  return json;
}

export async function desktopTransaction<T, R>(storage: DeviceStorageBridge, key: string, initial: () => T, operation: (record: T) => R, write: boolean): Promise<R> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await storage.read(key);
    const record = (current.value === null ? initial() : decode(current.value)) as T;
    const result = operation(record);
    if (!write || await storage.write(key, await encode(record), current.version)) return structuredClone(result);
  }
  throw new Error('另一窗口正在保存本地数据，请重试');
}
