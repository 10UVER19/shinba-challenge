(function () {
  "use strict";

  const ACTION = "syncHorseMemos";

  class MemoSyncError extends Error {
    constructor(type, message, details) {
      super(message);
      this.name = "MemoSyncError";
      this.type = type;
      this.details = details || null;
    }
  }

  function replaceTokens(template, values) {
    return String(template || "").replace(/\{\{([A-Za-z]+)\}\}/g, (match, key) => (
      Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
    ));
  }

  function buildMemoText(race, horse, date, template, toStars) {
    const ratings = race.ratings || race.rating || {};
    const level = Object.prototype.hasOwnProperty.call(ratings, "level") ? ratings.level : ratings.fieldLevel;
    const body = replaceTokens(template, {
      date,
      dateSlash: date.replace(/-/g, "/"),
      raceId: String(race.raceId || ""),
      raceName: String(race.raceName || ""),
      horseId: String(horse.horseId || ""),
      horseName: String(horse.name || horse.horseName || ""),
      mark: String(horse.mark || ""),
      expectationStars: toStars(ratings.expectation),
      levelStars: toStars(level),
      valueStars: toStars(ratings.value)
    }).trim();
    return `【新馬戦チャレンジ ${date} ${String(race.raceId || "")}】\n${body}\n【/新馬戦チャレンジ】`;
  }

  function buildRequest(record, settings, returnUrl, toStars) {
    if (!record || !/^\d{4}-\d{2}-\d{2}$/.test(String(record.date || ""))) {
      throw new MemoSyncError("INVALID_HISTORY", "同期対象の履歴日付が正しくありません。");
    }
    const items = [];
    record.races.forEach((race) => {
      (race.horses || []).forEach((horse) => {
        const horseId = String(horse.horseId || "").trim();
        if (!/^\d{10}$/.test(horseId)) return;
        items.push({
          syncKey: `${record.date}:${race.raceId}:${horseId}`,
          date: record.date,
          raceId: race.raceId,
          raceName: race.raceName,
          horseId,
          horseName: horse.name,
          memoText: buildMemoText(race, horse, record.date, settings.memoTemplate, toStars)
        });
      });
    });
    if (items.length === 0) {
      throw new MemoSyncError("HORSE_ID_NOT_FOUND", "horseIdを取得済みの馬がありません。");
    }
    return { action: ACTION, appId: window.ShinbaConfig.APP_ID, date: record.date, returnUrl, returnOrigin: new URL(returnUrl).origin, memoItems: items };
  }

  function validateResult(input) {
    let payload = input;
    if (typeof payload === "string") {
      try { payload = JSON.parse(payload); } catch (error) {
        throw new MemoSyncError("INVALID_JSON", "馬メモ同期結果のJSONが正しくありません。");
      }
    }
    if (!payload || typeof payload !== "object" || payload.action !== ACTION || !Array.isArray(payload.items)) {
      throw new MemoSyncError("INVALID_RESULT", "馬メモ同期結果の形式が正しくありません。");
    }
    return payload;
  }

  function applyResult(record, input) {
    const payload = validateResult(input);
    if (payload.date !== record.date) throw new MemoSyncError("DATE_MISMATCH", "同期結果の日付が履歴と一致しません。");
    const resultByKey = new Map(payload.items.map((item) => [String(item.syncKey || ""), item]));
    const updated = JSON.parse(JSON.stringify(record));
    updated.races.forEach((race) => {
      race.horses.forEach((horse) => {
        const key = `${record.date}:${race.raceId}:${horse.horseId || ""}`;
        const item = resultByKey.get(key);
        if (!item) return;
        horse.netkeibaMemoSync = item.status === "synced"
          ? { status: "synced", syncedAt: item.syncedAt || new Date().toISOString(), error: null }
          : { status: "error", syncedAt: null, error: item.error || { type: "MEMO_SYNC_FAILED", message: "同期に失敗しました。" } };
      });
    });
    updated.updatedAt = new Date().toISOString();
    return updated;
  }

  window.ShinbaMemoSync = { ACTION, MemoSyncError, buildMemoText, buildRequest, validateResult, applyResult };
}());
