(function () {
  "use strict";

  const HISTORY_SCHEMA_VERSION = 2;
  const BACKUP_FORMAT = "shinba-challenge-history-backup";
  const BACKUP_VERSION = 2;
  const SUPPORTED_BACKUP_VERSIONS = new Set([1, 2]);
  const VALID_MARKS = new Set(["◎", "○", "▲", "△", "☆", "注", "✓"]);

  class HistoryValidationError extends Error {
    constructor(type, message, details) {
      super(message);
      this.name = "HistoryValidationError";
      this.type = type;
      this.details = details || null;
    }
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function normalizeDate(value, label) {
    const date = String(value || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new HistoryValidationError("INVALID_DATE", `${label || "日付"}はYYYY-MM-DD形式で指定してください。`);
    }
    const parsed = new Date(`${date}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new HistoryValidationError("INVALID_DATE", `${label || "日付"}が正しくありません。`);
    }
    return date;
  }

  function normalizeTimestamp(value, fallback) {
    const parsed = new Date(String(value || ""));
    return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
  }

  function normalizeNullableText(value, maxLength) {
    const text = String(value == null ? "" : value).trim();
    return text ? text.slice(0, maxLength) : null;
  }

  function clampRating(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.min(5, Math.max(0, Math.round(number)));
  }

  function normalizeRating(source) {
    const rating = isPlainObject(source) ? source : {};
    return {
      expectation: clampRating(rating.expectation),
      level: clampRating(Object.prototype.hasOwnProperty.call(rating, "level") ? rating.level : rating.fieldLevel),
      value: clampRating(rating.value)
    };
  }

  function normalizeMark(value) {
    const raw = String(value || "").trim();
    const normalized = raw === "◯" ? "○" : raw === "✔" ? "✓" : raw;
    return VALID_MARKS.has(normalized) ? normalized : null;
  }

  function normalizeMemoSync(value) {
    const source = isPlainObject(value) ? value : {};
    const status = ["not_synced", "pending", "synced", "error"].includes(source.status)
      ? source.status
      : "not_synced";
    return {
      status,
      syncedAt: status === "synced" ? normalizeTimestamp(source.syncedAt, null) : null,
      error: status === "error" && isPlainObject(source.error)
        ? { type: String(source.error.type || "MEMO_SYNC_FAILED"), message: String(source.error.message || "同期に失敗しました。").slice(0, 300) }
        : null
    };
  }

  function normalizeRaceResult(value) {
    const source = isPlainObject(value) ? value : {};
    return {
      status: ["pending", "fetched", "error"].includes(source.status) ? source.status : "pending",
      finishOrder: Array.isArray(source.finishOrder) ? source.finishOrder : [],
      payouts: Array.isArray(source.payouts) ? source.payouts : [],
      fetchedAt: source.fetchedAt ? normalizeTimestamp(source.fetchedAt, null) : null
    };
  }

  function normalizeAnalysis(value) {
    const source = isPlainObject(value) ? value : {};
    return {
      status: ["not_analyzed", "analyzed", "error"].includes(source.status) ? source.status : "not_analyzed",
      predictionVsResult: source.predictionVsResult == null ? null : source.predictionVsResult,
      features: isPlainObject(source.features) ? source.features : {},
      notes: Array.isArray(source.notes) ? source.notes.slice(0, 100) : [],
      analyzedAt: source.analyzedAt ? normalizeTimestamp(source.analyzedAt, null) : null
    };
  }

  function normalizeHorse(source, index) {
    if (!isPlainObject(source)) {
      throw new HistoryValidationError("INVALID_HORSE", `${index + 1}頭目のデータが正しくありません。`);
    }
    const number = Number(source.number);
    const name = String(source.name || source.horseName || "").trim();
    const mark = normalizeMark(source.mark);
    if (!Number.isInteger(number) || number < 1 || number > 40) {
      throw new HistoryValidationError("INVALID_HORSE_NUMBER", `${index + 1}頭目の馬番が正しくありません。`);
    }
    if (!name) {
      throw new HistoryValidationError("HORSE_NAME_NOT_FOUND", `馬番${number}の馬名がありません。`);
    }
    if (!mark) {
      throw new HistoryValidationError("INVALID_MARK", `馬番${number}の印が正しくありません。`);
    }
    return {
      horseId: normalizeNullableText(source.horseId, 32),
      number,
      name: name.slice(0, 80),
      mark,
      horseMemo: source.horseMemo == null ? null : source.horseMemo,
      netkeibaMemoSync: normalizeMemoSync(source.netkeibaMemoSync)
    };
  }

  function normalizeRace(source, date, timestamps) {
    if (!isPlainObject(source)) {
      throw new HistoryValidationError("INVALID_RACE", "レースデータが正しくありません。");
    }
    const raceName = String(source.raceName || "").trim();
    const raceTime = String(source.raceTime || "").trim().padStart(5, "0");
    const horseSources = Array.isArray(source.horses)
      ? source.horses
      : Array.isArray(source.marks) ? source.marks : null;
    if (!raceName) throw new HistoryValidationError("RACE_NAME_NOT_FOUND", "raceNameがありません。");
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raceTime)) {
      throw new HistoryValidationError("INVALID_RACE_TIME", `${raceName}のraceTimeが正しくありません。`);
    }
    if (!horseSources || horseSources.length === 0) {
      throw new HistoryValidationError("HORSES_NOT_FOUND", `${raceName}に印付きの馬がありません。`);
    }
    let identity;
    try {
      identity = window.ShinbaImport.resolveRaceIdentity(source, { required: true });
    } catch (error) {
      throw new HistoryValidationError(
        error.type || "INVALID_RACE_URL",
        `${raceName}のraceId / raceUrlが正しくありません。`,
        error.details
      );
    }
    const horses = horseSources.map(normalizeHorse);
    if (horses.filter((horse) => horse.mark === "◎").length > 1) {
      throw new HistoryValidationError("DUPLICATE_HONMEI", `${raceName}に◎が2頭以上あります。`);
    }
    return {
      date,
      raceId: identity.raceId,
      raceName: raceName.slice(0, 80),
      raceTime,
      raceUrl: identity.raceUrl,
      raceLabel: String(source.raceLabel || "").trim().slice(0, 120),
      horses,
      ratings: normalizeRating(source.ratings || source.rating),
      memo: String(source.memo == null ? timestamps.memo : source.memo).slice(0, 40),
      createdAt: normalizeTimestamp(source.createdAt, timestamps.createdAt),
      updatedAt: normalizeTimestamp(source.updatedAt, timestamps.updatedAt),
      betPlan: source.betPlan == null ? null : window.ShinbaBetPlan.normalize(source.betPlan, identity.raceId),
      raceResult: normalizeRaceResult(source.raceResult),
      analysis: normalizeAnalysis(source.analysis)
    };
  }

  function normalizeHistoryRecord(source, options) {
    if (!isPlainObject(source)) {
      throw new HistoryValidationError("INVALID_HISTORY", "履歴データが正しくありません。");
    }
    const now = options && options.now || new Date().toISOString();
    const date = normalizeDate(source.date, "履歴の日付");
    const createdAt = normalizeTimestamp(source.createdAt, now);
    const updatedAt = normalizeTimestamp(source.updatedAt, now);
    const memo = String(source.memo || "").slice(0, 40);
    if (!Array.isArray(source.races) || source.races.length === 0) {
      throw new HistoryValidationError("RACES_NOT_FOUND", `${date}に保存できるレースがありません。`);
    }
    const seen = new Set();
    const races = source.races.map((race) => normalizeRace(race, date, { createdAt, updatedAt, memo }))
      .sort((a, b) => a.raceTime.localeCompare(b.raceTime) || String(a.raceId || "").localeCompare(String(b.raceId || "")));
    races.forEach((race) => {
      const key = race.raceId ? `id:${race.raceId}` : `fallback:${race.raceName}\u0000${race.raceTime}`;
      if (seen.has(key)) {
        throw new HistoryValidationError("DUPLICATE_RACE", `${race.raceName}が重複しています。`);
      }
      seen.add(key);
    });
    return {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      date,
      memo,
      createdAt,
      updatedAt,
      races
    };
  }

  function raceKey(race) {
    return String(race && race.raceId || "").trim()
      || `${String(race && race.raceName || "").trim()}\u0000${String(race && race.raceTime || "").trim()}`;
  }

  function createHistoryRecord(options) {
    const now = options.now || new Date().toISOString();
    const date = normalizeDate(options.date, "開催日");
    const sources = Array.isArray(options.sources) ? options.sources : [];
    const sourceByKey = new Map(sources.map((source) => [raceKey(source), source]));
    const sourceByNameTime = new Map(sources.map((source) => [
      `${String(source.raceName || "").trim()}\u0000${String(source.raceTime || "").trim()}`,
      source
    ]));
    const existing = options.existing && isPlainObject(options.existing) ? options.existing : null;
    const existingByKey = new Map(existing && Array.isArray(existing.races)
      ? existing.races.map((race) => [raceKey(race), race])
      : []);
    const memo = String(options.memo || "").slice(0, 40);
    const races = options.races.map((race) => {
      const nameTimeKey = `${String(race.raceName || "").trim()}\u0000${String(race.raceTime || "").trim()}`;
      const source = sourceByKey.get(raceKey(race)) || sourceByNameTime.get(nameTimeKey) || {};
      const previous = existingByKey.get(raceKey(source)) || existingByKey.get(raceKey(race)) || {};
      const sourceHorses = Array.isArray(source.horses) ? source.horses : [];
      const previousHorses = Array.isArray(previous.horses) ? previous.horses : [];
      return {
        ...source,
        raceId: source.raceId || race.raceId || previous.raceId || null,
        raceName: race.raceName,
        raceTime: race.raceTime,
        raceUrl: source.raceUrl || race.raceUrl || previous.raceUrl || "",
        raceLabel: source.raceLabel || race.raceLabel || previous.raceLabel || "",
        horses: race.marks.map((entry) => {
          const stored = sourceHorses.find((horse) => String(horse.horseId || "") === String(entry.horseId || "") && entry.horseId)
            || sourceHorses.find((horse) => Number(horse.number) === Number(entry.number))
            || previousHorses.find((horse) => String(horse.horseId || "") === String(entry.horseId || "") && entry.horseId)
            || previousHorses.find((horse) => Number(horse.number) === Number(entry.number))
            || {};
          return {
            horseId: entry.horseId || stored.horseId || null,
            number: entry.number,
            name: entry.horseName,
            mark: entry.mark,
            horseMemo: entry.horseMemo == null ? (stored.horseMemo == null ? null : stored.horseMemo) : entry.horseMemo,
            netkeibaMemoSync: entry.netkeibaMemoSync == null ? stored.netkeibaMemoSync : entry.netkeibaMemoSync
          };
        }),
        ratings: race.rating,
        memo,
        createdAt: previous.createdAt || now,
        updatedAt: now,
        betPlan: source.betPlan == null ? (previous.betPlan == null ? null : previous.betPlan) : source.betPlan,
        raceResult: source.raceResult == null ? previous.raceResult : source.raceResult,
        analysis: source.analysis == null ? previous.analysis : source.analysis
      };
    });
    return normalizeHistoryRecord({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      date,
      memo,
      createdAt: existing && existing.createdAt || now,
      updatedAt: now,
      races
    }, { now });
  }

  function toWorkingState(record) {
    const normalized = normalizeHistoryRecord(record);
    const sources = normalized.races.map((race) => ({
      date: race.date,
      raceId: race.raceId,
      raceName: race.raceName,
      raceTime: race.raceTime,
      raceUrl: race.raceUrl,
      raceLabel: race.raceLabel,
      horses: race.horses.map((horse) => ({
        horseId: horse.horseId,
        number: horse.number,
        name: horse.name,
        mark: horse.mark === "○" ? "◯" : horse.mark,
        horseMemo: horse.horseMemo,
        netkeibaMemoSync: horse.netkeibaMemoSync
      })),
      rating: {
        expectation: race.ratings.expectation,
        level: race.ratings.level,
        value: race.ratings.value
      },
      betPlan: race.betPlan,
      raceResult: race.raceResult,
      analysis: race.analysis
    }));
    return {
      date: normalized.date,
      memo: normalized.memo,
      sources,
      ratings: normalized.races.map((race) => ({
        expectation: race.ratings.expectation,
        fieldLevel: race.ratings.level,
        value: race.ratings.value
      }))
    };
  }

  function createLegacyRecord(saved, now) {
    if (!isPlainObject(saved) || !Array.isArray(saved.importedRaceSources) || saved.importedRaceSources.length === 0) return null;
    const date = String(saved.storyMeta && saved.storyMeta.date || saved.newcomerDate || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const list = Array.isArray(saved.newcomerList) ? saved.newcomerList : [];
    const listByKey = new Map(list.map((race) => [raceKey(race), race]));
    const ratings = isPlainObject(saved.ratings) ? saved.ratings : {};
    const sources = saved.importedRaceSources.map((source) => {
      const matched = listByKey.get(raceKey(source)) || list.find((race) => (
        String(race.raceName || "").trim() === String(source.raceName || "").trim()
        && String(race.raceTime || "").trim() === String(source.raceTime || "").trim()
      )) || {};
      const stableId = window.ShinbaImport && typeof window.ShinbaImport.createStableId === "function"
        ? window.ShinbaImport.createStableId(source.raceName, source.raceTime)
        : "";
      return {
        ...source,
        raceId: source.raceId || matched.raceId || null,
        raceUrl: source.raceUrl || matched.raceUrl || "",
        raceLabel: source.raceLabel || matched.raceLabel || "",
        ratings: source.ratings || source.rating || ratings[stableId] || { expectation: 0, level: 0, value: 0 }
      };
    });
    return normalizeHistoryRecord({
      schemaVersion: HISTORY_SCHEMA_VERSION,
      date,
      memo: String(saved.storyMeta && saved.storyMeta.memo || "").slice(0, 40),
      createdAt: now,
      updatedAt: now,
      races: sources
    }, { now });
  }

  function createBackup(histories, exportedAt) {
    const normalized = histories.map((record) => normalizeHistoryRecord(record));
    return {
      format: BACKUP_FORMAT,
      backupVersion: BACKUP_VERSION,
      historySchemaVersion: HISTORY_SCHEMA_VERSION,
      exportedAt: normalizeTimestamp(exportedAt, new Date().toISOString()),
      histories: normalized.sort((a, b) => b.date.localeCompare(a.date))
    };
  }

  function validateBackup(input) {
    let source = input;
    if (typeof source === "string") {
      try {
        source = JSON.parse(source);
      } catch (error) {
        throw new HistoryValidationError("INVALID_BACKUP_JSON", "バックアップJSONの形式が正しくありません。");
      }
    }
    if (!isPlainObject(source) || source.format !== BACKUP_FORMAT || !SUPPORTED_BACKUP_VERSIONS.has(source.backupVersion)) {
      throw new HistoryValidationError("INVALID_BACKUP_FORMAT", "新馬戦チャレンジの対応バックアップではありません。");
    }
    if (!Array.isArray(source.histories)) {
      throw new HistoryValidationError("INVALID_BACKUP_HISTORIES", "バックアップに履歴一覧がありません。");
    }
    const dates = new Set();
    const histories = source.histories.map((record) => {
      const normalized = normalizeHistoryRecord(record);
      if (dates.has(normalized.date)) {
        throw new HistoryValidationError("DUPLICATE_BACKUP_DATE", `${normalized.date}の履歴が重複しています。`);
      }
      dates.add(normalized.date);
      return normalized;
    });
    return createBackup(histories, source.exportedAt);
  }

  window.ShinbaHistoryModel = {
    HISTORY_SCHEMA_VERSION,
    BACKUP_FORMAT,
    BACKUP_VERSION,
    HistoryValidationError,
    normalizeHistoryRecord,
    createHistoryRecord,
    toWorkingState,
    createLegacyRecord,
    createBackup,
    validateBackup
  };
}());
