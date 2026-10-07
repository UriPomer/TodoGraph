let database: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('todograph-device', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onerror = () => { database = undefined; reject(request.error ?? new Error('无法打开本地数据库')); };
    request.onblocked = () => { database = undefined; reject(new Error('本地数据库升级被其他窗口阻止，请关闭其他 TodoGraph 窗口后重试')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); database = undefined; };
      resolve(db);
    };
  });
  return database;
}

/** IndexedDB serializes read/write transactions across tabs; callbacks must stay synchronous. */
export async function deviceTransaction<T, R>(key: string, initial: () => T,
  operation: (record: T) => R, write = true): Promise<R> {
  if (window.todograph?.deviceStorage) {
    const { desktopTransaction } = await import('./desktopRecords');
    return desktopTransaction(window.todograph.deviceStorage, key, initial, operation, write);
  }
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('records', write ? 'readwrite' : 'readonly');
    const store = transaction.objectStore('records');
    let result: R;
    let failure: unknown;
    const request = store.get(key);
    request.onsuccess = () => {
      try {
        const record = (request.result ?? initial()) as T;
        result = operation(record);
        if (write) store.put(record, key);
      } catch (error) { failure = error; transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => reject(failure ?? transaction.error ?? new Error('本地保存失败，请导出数据并检查设备可用空间'));
  });
}

export const readDeviceRecord = <T>(key: string, initial: () => T) => deviceTransaction(key, initial, record => record, false);
export const writeDeviceRecord = <T>(key: string, value: T) => deviceTransaction(key, () => structuredClone(value), record => {
  // Records may include Blob objects; structured cloning is owned by IndexedDB.
  Object.keys(record as object).forEach(name => delete (record as Record<string, unknown>)[name]);
  Object.assign(record as object, value);
});
