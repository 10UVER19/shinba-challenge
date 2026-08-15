(function () {
  "use strict";

  const DATABASE_NAME = "shinba-challenge-v2";
  const DATABASE_VERSION = 1;
  const HISTORY_STORE = "histories";
  const META_STORE = "meta";
  const LEGACY_MIGRATION_KEY = "migration:shinba-challenge-step1-v1:v1";
  const HISTORY_SCHEMA_MIGRATION_KEY = "migration:history-schema:v2";

  class HistoryStoreError extends Error {
    constructor(type, message, details) {
      super(message);
      this.name = "HistoryStoreError";
      this.type = type;
      this.details = details || null;
    }
  }

  let databasePromise = null;

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener("error", () => reject(request.error), { once: true });
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.addEventListener("complete", resolve, { once: true });
      transaction.addEventListener("abort", () => reject(transaction.error || new Error("保存処理が中断されました。")), { once: true });
      transaction.addEventListener("error", () => reject(transaction.error || new Error("保存処理に失敗しました。")), { once: true });
    });
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    if (!window.indexedDB) {
      return Promise.reject(new HistoryStoreError("INDEXED_DB_UNAVAILABLE", "このブラウザでは日付別履歴を保存できません。"));
    }
    databasePromise = new Promise((resolve, reject) => {
      const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(HISTORY_STORE)) {
          database.createObjectStore(HISTORY_STORE, { keyPath: "date" });
        }
        if (!database.objectStoreNames.contains(META_STORE)) {
          database.createObjectStore(META_STORE, { keyPath: "key" });
        }
      });
      request.addEventListener("success", () => {
        const database = request.result;
        database.addEventListener("versionchange", () => database.close());
        resolve(database);
      }, { once: true });
      request.addEventListener("error", () => {
        databasePromise = null;
        reject(new HistoryStoreError("INDEXED_DB_OPEN_FAILED", "日付別履歴の保存領域を開けませんでした。", request.error));
      }, { once: true });
      request.addEventListener("blocked", () => {
        console.warn("日付別履歴の更新が別タブにより待機しています。");
      });
    });
    return databasePromise;
  }

  async function getHistory(date) {
    const database = await openDatabase();
    const transaction = database.transaction(HISTORY_STORE, "readonly");
    const record = await requestToPromise(transaction.objectStore(HISTORY_STORE).get(String(date)));
    return record ? window.ShinbaHistoryModel.normalizeHistoryRecord(record) : null;
  }

  async function listHistories() {
    const database = await openDatabase();
    const transaction = database.transaction(HISTORY_STORE, "readonly");
    const records = await requestToPromise(transaction.objectStore(HISTORY_STORE).getAll());
    return records.flatMap((record) => {
      try {
        return [window.ShinbaHistoryModel.normalizeHistoryRecord(record)];
      } catch (error) {
        console.warn("形式が正しくない履歴を一覧から除外しました。保存データ自体は削除していません。", error);
        return [];
      }
    }).sort((a, b) => b.date.localeCompare(a.date));
  }

  async function putHistory(record) {
    const normalized = window.ShinbaHistoryModel.normalizeHistoryRecord(record);
    const database = await openDatabase();
    const transaction = database.transaction(HISTORY_STORE, "readwrite");
    transaction.objectStore(HISTORY_STORE).put(normalized);
    await transactionDone(transaction);
    return normalized;
  }

  async function deleteHistory(date) {
    const database = await openDatabase();
    const transaction = database.transaction(HISTORY_STORE, "readwrite");
    transaction.objectStore(HISTORY_STORE).delete(String(date));
    await transactionDone(transaction);
  }

  async function exportBackup() {
    return window.ShinbaHistoryModel.createBackup(await listHistories(), new Date().toISOString());
  }

  async function importBackup(input) {
    const backup = window.ShinbaHistoryModel.validateBackup(input);
    const database = await openDatabase();
    const transaction = database.transaction(HISTORY_STORE, "readwrite");
    const store = transaction.objectStore(HISTORY_STORE);
    backup.histories.forEach((history) => store.put(history));
    await transactionDone(transaction);
    return { importedCount: backup.histories.length, histories: backup.histories };
  }

  async function migrateLegacyStorage(storageKey) {
    const database = await openDatabase();
    const readTransaction = database.transaction(META_STORE, "readonly");
    const migrated = await requestToPromise(readTransaction.objectStore(META_STORE).get(LEGACY_MIGRATION_KEY));
    if (migrated) return { status: "already_migrated", imported: false };

    let legacy = null;
    try {
      const raw = window.localStorage.getItem(storageKey);
      legacy = raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.warn("v1.0保存データを解析できなかったため、移行を見送りました。", error);
    }

    const now = new Date().toISOString();
    let record = null;
    try {
      record = window.ShinbaHistoryModel.createLegacyRecord(legacy, now);
    } catch (error) {
      console.warn("v1.0保存データを履歴へ移行できませんでした。旧データは保持されています。", error);
    }

    const existing = record ? await getHistory(record.date) : null;
    const stores = record ? [HISTORY_STORE, META_STORE] : [META_STORE];
    const writeTransaction = database.transaction(stores, "readwrite");
    if (record && !existing) writeTransaction.objectStore(HISTORY_STORE).put(record);
    writeTransaction.objectStore(META_STORE).put({
      key: LEGACY_MIGRATION_KEY,
      migrationVersion: 1,
      completedAt: now,
      importedDate: record ? record.date : null
    });
    await transactionDone(writeTransaction);
    return { status: record ? "migrated" : "no_legacy_history", imported: Boolean(record), date: record && record.date };
  }

  async function migrateHistorySchema() {
    const database = await openDatabase();
    const readTransaction = database.transaction([HISTORY_STORE, META_STORE], "readonly");
    const migrated = await requestToPromise(readTransaction.objectStore(META_STORE).get(HISTORY_SCHEMA_MIGRATION_KEY));
    if (migrated) return { status: "already_migrated", updatedCount: 0 };
    const records = await requestToPromise(readTransaction.objectStore(HISTORY_STORE).getAll());
    const normalized = records.flatMap((record) => {
      try { return [window.ShinbaHistoryModel.normalizeHistoryRecord(record)]; }
      catch (error) {
        console.warn("不正な履歴は保持したままschema移行対象から除外しました。", error);
        return [];
      }
    });
    const writeTransaction = database.transaction([HISTORY_STORE, META_STORE], "readwrite");
    const historyStore = writeTransaction.objectStore(HISTORY_STORE);
    normalized.forEach((record) => historyStore.put(record));
    writeTransaction.objectStore(META_STORE).put({
      key: HISTORY_SCHEMA_MIGRATION_KEY,
      schemaVersion: window.ShinbaHistoryModel.HISTORY_SCHEMA_VERSION,
      completedAt: new Date().toISOString(),
      updatedCount: normalized.length
    });
    await transactionDone(writeTransaction);
    return { status: "migrated", updatedCount: normalized.length };
  }

  window.ShinbaHistoryStore = {
    DATABASE_NAME,
    DATABASE_VERSION,
    HistoryStoreError,
    openDatabase,
    getHistory,
    listHistories,
    putHistory,
    deleteHistory,
    exportBackup,
    importBackup,
    migrateLegacyStorage,
    migrateHistorySchema
  };
}());
