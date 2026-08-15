(function () {
  "use strict";

  class RaceBatchError extends Error {
    constructor(type, message, details) {
      super(message);
      this.name = "RaceBatchError";
      this.type = type;
      this.details = details || null;
    }
  }

  function parseJson(input, label) {
    if (typeof input !== "string") return input;
    try {
      return JSON.parse(input);
    } catch (error) {
      throw new RaceBatchError("INVALID_JSON", `${label}のJSON形式が正しくありません。`);
    }
  }

  function normalizeRaceId(race) {
    const explicitId = String(race && race.raceId || "").trim();
    if (explicitId) return explicitId;
    try {
      return new URL(String(race && race.raceUrl || "")).searchParams.get("race_id") || "";
    } catch (error) {
      return "";
    }
  }

  function raceKey(race) {
    return normalizeRaceId(race) || `${String(race && race.raceName || "").trim()}\u0000${String(race && race.raceTime || "").trim()}`;
  }

  function resolveRaceIdentity(race, label) {
    try {
      return window.ShinbaImport.resolveRaceIdentity(race, { required: true });
    } catch (error) {
      throw new RaceBatchError(
        error.type || "INVALID_RACE_URL",
        `${label || "対象レース"}のraceId / raceUrlを確認してください。`,
        error.details
      );
    }
  }

  function buildPythonistaRequest(date, selectedRaces) {
    const normalizedDate = String(date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
      throw new RaceBatchError("INVALID_DATE", "開催日はYYYY-MM-DD形式で指定してください。");
    }
    if (!Array.isArray(selectedRaces) || selectedRaces.length === 0) {
      throw new RaceBatchError("NO_SELECTED_RACES", "対象レースを1つ以上選択してください。");
    }

    const seen = new Set();
    const races = selectedRaces.map((race, index) => {
      if (!race || typeof race !== "object") {
        throw new RaceBatchError("INVALID_SELECTED_RACE", `${index + 1}件目の選択データが正しくありません。`);
      }
      const identity = resolveRaceIdentity(race, `${index + 1}件目`);
      const normalized = {
        raceName: String(race.raceName || "").trim(),
        raceTime: String(race.raceTime || "").trim(),
        raceUrl: identity.raceUrl,
        raceId: identity.raceId,
        raceLabel: String(race.raceLabel || "").trim()
      };
      if (!normalized.raceName || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(normalized.raceTime)) {
        throw new RaceBatchError("INVALID_SELECTED_RACE", `${index + 1}件目のraceName / raceTimeを確認してください。`);
      }
      if (seen.has(normalized.raceId)) {
        throw new RaceBatchError("DUPLICATE_RACE_ID", `raceId ${normalized.raceId} が重複しています。`);
      }
      seen.add(normalized.raceId);
      return normalized;
    }).sort((a, b) => a.raceTime.localeCompare(b.raceTime) || a.raceId.localeCompare(b.raceId));

    return { action: "collectSelectedRaces", date: normalizedDate, selectedRaces: races };
  }

  function normalizeFailure(source, fallbackRace) {
    const error = source && source.error || {};
    return {
      raceId: String(source && source.raceId || fallbackRace && fallbackRace.raceId || "").trim(),
      raceName: String(source && source.raceName || fallbackRace && fallbackRace.raceName || "対象レース").trim(),
      type: String(error.type || source && source.type || "RACE_FETCH_FAILED"),
      message: String(error.message || source && source.message || "出馬表を取得できませんでした。")
    };
  }

  function validatePythonistaResultPayload(input) {
    const payload = parseJson(input, "Pythonista取得結果");
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new RaceBatchError("INVALID_PAYLOAD", "Pythonista取得結果のJSONオブジェクトを指定してください。");
    }
    if (Object.prototype.hasOwnProperty.call(payload, "selectedRaces")) {
      throw new RaceBatchError(
        "PYTHONISTA_RESULT_NOT_READY",
        "クリップボードにはPythonista入力JSONが残っています。取得完了後にもう一度読み込んでください。"
      );
    }
    if (typeof payload.success !== "boolean" || !Array.isArray(payload.races)) {
      throw new RaceBatchError(
        "INVALID_PYTHONISTA_RESULT",
        "successとracesを持つPythonista完成JSONではありません。"
      );
    }
    payload.races.forEach((race, index) => {
      if (!race || typeof race !== "object" || Array.isArray(race) || !Array.isArray(race.horses)) {
        throw new RaceBatchError(
          "INVALID_PYTHONISTA_RESULT",
          `${index + 1}件目のレースにhorses配列がありません。`
        );
      }
    });
    return payload;
  }

  function importBatchResult(input, expectedRequest) {
    const payload = validatePythonistaResultPayload(input);
    const expected = buildPythonistaRequest(expectedRequest && expectedRequest.date, expectedRequest && expectedRequest.selectedRaces);
    const resultDate = String(payload.date || "").trim();
    if (resultDate !== expected.date) {
      throw new RaceBatchError("DATE_MISMATCH", `取得結果の日付（${resultDate || "未設定"}）が選択日（${expected.date}）と一致しません。`);
    }

    const successfulByKey = new Map();
    const failuresByKey = new Map();
    const resultEntries = Array.isArray(payload.results) ? payload.results : [];
    const topLevelRaces = Array.isArray(payload.races) ? payload.races : [];
    const topLevelErrors = Array.isArray(payload.errors) ? payload.errors : [];

    topLevelRaces.forEach((race) => successfulByKey.set(raceKey(race), race));
    resultEntries.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      if (entry.success === true && entry.race) successfulByKey.set(raceKey(entry.race), entry.race);
      if (entry.success === false) failuresByKey.set(raceKey(entry), normalizeFailure(entry));
    });
    topLevelErrors.forEach((entry) => {
      if (!entry || typeof entry !== "object") return;
      failuresByKey.set(raceKey(entry), normalizeFailure(entry));
    });

    const importedRaces = [];
    const importedSources = [];
    const progress = [];
    const errors = [];

    expected.selectedRaces.forEach((selectedRace) => {
      const key = raceKey(selectedRace);
      const source = successfulByKey.get(key)
        || Array.from(successfulByKey.values()).find((race) => raceKey(race) === key || (
          String(race.raceName || "").trim() === selectedRace.raceName
          && String(race.raceTime || "").trim() === selectedRace.raceTime
        ));
      const failure = failuresByKey.get(key)
        || Array.from(failuresByKey.values()).find((item) => item.raceName === selectedRace.raceName);

      if (failure) {
        const normalized = normalizeFailure(failure, selectedRace);
        errors.push(normalized);
        progress.push({ ...selectedRace, status: "error", error: normalized });
        return;
      }
      if (!source) {
        const missing = normalizeFailure({
          raceId: selectedRace.raceId,
          raceName: selectedRace.raceName,
          error: { type: "RACE_RESULT_MISSING", message: "Pythonista取得結果にこのレースが含まれていません。" }
        }, selectedRace);
        errors.push(missing);
        progress.push({ ...selectedRace, status: "error", error: missing });
        return;
      }

      try {
        const identity = resolveRaceIdentity({
          raceId: String(source.raceId || selectedRace.raceId),
          raceUrl: String(source.raceUrl || selectedRace.raceUrl || "")
        }, selectedRace.raceName);
        const sourceWithExpected = {
          ...source,
          date: expected.date,
          raceId: identity.raceId,
          raceName: String(source.raceName || selectedRace.raceName),
          raceTime: String(source.raceTime || selectedRace.raceTime),
          raceUrl: identity.raceUrl,
          raceLabel: String(source.raceLabel || selectedRace.raceLabel || "")
        };
        const importedRace = window.ShinbaImport.importRaceData(sourceWithExpected);
        importedRaces.push(importedRace);
        importedSources.push(window.ShinbaImport.toExternalRace(importedRace));
        progress.push({ ...selectedRace, status: "success" });
      } catch (error) {
        const invalid = {
          raceId: selectedRace.raceId,
          raceName: selectedRace.raceName,
          type: error.type || "INVALID_RACE_RESULT",
          message: error.message || "取得したレースデータを読み込めませんでした。"
        };
        errors.push(invalid);
        progress.push({ ...selectedRace, status: "error", error: invalid });
      }
    });

    if (payload.success === false && errors.length === 0 && payload.error) {
      errors.push(normalizeFailure({ error: payload.error }, null));
    }

    const sortedPairs = importedRaces.map((race, index) => ({ race, source: importedSources[index] }))
      .sort((a, b) => a.race.raceTime.localeCompare(b.race.raceTime));
    return {
      isComplete: errors.length === 0 && sortedPairs.length === expected.selectedRaces.length,
      date: resultDate,
      races: sortedPairs.map((item) => item.race),
      sources: sortedPairs.map((item) => item.source),
      errors,
      progress
    };
  }

  window.ShinbaBatch = {
    RaceBatchError,
    buildPythonistaRequest,
    validatePythonistaResultPayload,
    importBatchResult
  };
}());
