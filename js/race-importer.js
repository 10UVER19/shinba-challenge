(function () {
  "use strict";

  const MARK_ALIASES = {
    "◎": "◎",
    "◯": "○",
    "○": "○",
    "▲": "▲",
    "△": "△",
    "☆": "☆",
    "注": "注",
    "✓": "✓",
    "✔": "✓"
  };

  class RaceImportError extends Error {
    constructor(type, message, details) {
      super(message);
      this.name = "RaceImportError";
      this.type = type;
      this.details = details || null;
    }
  }

  const RACE_ID_PATTERN = /^\d{12}$/;
  const RACE_URL_HOST = "race.sp.netkeiba.com";
  const RACE_URL_PATH = "/race/shutuba.html";

  function buildRaceUrl(raceId) {
    const normalizedId = String(raceId || "").trim();
    if (!RACE_ID_PATTERN.test(normalizedId)) {
      throw new RaceImportError("INVALID_RACE_ID", "raceIdは12桁で指定してください。", { raceId: normalizedId || null });
    }
    return `https://${RACE_URL_HOST}${RACE_URL_PATH}?race_id=${normalizedId}`;
  }

  function resolveRaceIdentity(source, options) {
    const input = source && typeof source === "object" ? source : {};
    const required = Boolean(options && options.required);
    let raceId = String(input.raceId || "").trim();
    const rawUrl = String(input.raceUrl || "").trim();

    if (!raceId && rawUrl && !required) {
      try {
        raceId = new URL(rawUrl).searchParams.get("race_id") || "";
      } catch (error) {
        throw new RaceImportError("INVALID_RACE_URL", "raceUrlの形式が正しくありません。", { raceUrl: rawUrl });
      }
    }
    if (!raceId && !rawUrl && !required) return { raceId: null, raceUrl: "" };
    if (!RACE_ID_PATTERN.test(raceId)) {
      throw new RaceImportError(
        raceId ? "INVALID_RACE_ID" : "RACE_ID_NOT_FOUND",
        raceId ? "raceIdは12桁で指定してください。" : "raceIdがありません。",
        { raceId: raceId || null }
      );
    }
    if (!rawUrl) return { raceId, raceUrl: buildRaceUrl(raceId) };

    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch (error) {
      throw new RaceImportError("INVALID_RACE_URL", "raceUrlの形式が正しくありません。", { raceId });
    }
    const urlRaceId = parsed.searchParams.get("race_id") || "";
    if (
      parsed.protocol !== "https:"
      || parsed.hostname !== RACE_URL_HOST
      || parsed.pathname !== RACE_URL_PATH
      || urlRaceId !== raceId
    ) {
      throw new RaceImportError(
        "INVALID_RACE_URL",
        "raceUrlのhost / path / race_idがraceIdと一致しません。",
        { raceId, host: parsed.hostname, path: parsed.pathname, urlRaceId: urlRaceId || null }
      );
    }
    return { raceId, raceUrl: parsed.href };
  }

  function normalizeMark(mark) {
    return MARK_ALIASES[String(mark || "").trim()] || null;
  }

  function unwrapPayload(input) {
    let payload = input;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (error) {
        throw new RaceImportError("INVALID_JSON", "JSONの形式が正しくありません。");
      }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new RaceImportError("INVALID_PAYLOAD", "1レース分のJSONオブジェクトを指定してください。");
    }
    if (payload.success === false) {
      const sourceError = payload.error || {};
      throw new RaceImportError(sourceError.type || "EXPORT_ERROR", sourceError.message || "netkeibaデータの取得に失敗しました。", sourceError.details);
    }
    return payload.success === true && payload.data ? payload.data : payload;
  }

  function createStableId(raceName, raceTime) {
    const source = `${raceName}-${raceTime}`;
    let hash = 0;
    for (const character of source) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0;
    return `imported-${Math.abs(hash).toString(36)}`;
  }

  function importRaceData(input) {
    const source = unwrapPayload(input);
    const raceName = String(source.raceName || "").trim();
    const raceTime = String(source.raceTime || "").trim();

    if (!raceName) throw new RaceImportError("RACE_NAME_NOT_FOUND", "raceNameがありません。");
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(raceTime)) {
      throw new RaceImportError("INVALID_RACE_TIME", "raceTimeはHH:MM形式で指定してください。");
    }
    if (!Array.isArray(source.horses)) {
      throw new RaceImportError("HORSES_NOT_FOUND", "horses配列がありません。");
    }
    const identity = resolveRaceIdentity(source, { required: false });

    const marks = source.horses.flatMap((horse, index) => {
      if (!horse || typeof horse !== "object") {
        throw new RaceImportError("INVALID_HORSE", `${index + 1}頭目のデータが正しくありません。`);
      }
      const mark = normalizeMark(horse.mark);
      if (!mark || String(horse.mark || "").trim() === "消") return [];
      const number = Number(horse.number);
      const horseName = String(horse.name || horse.horseName || "").trim();
      if (!Number.isInteger(number) || number < 1 || number > 40) {
        throw new RaceImportError("INVALID_HORSE_NUMBER", `${index + 1}頭目の馬番が正しくありません。`);
      }
      if (!horseName) {
        throw new RaceImportError("HORSE_NAME_NOT_FOUND", `馬番${number}の馬名がありません。`, { number });
      }
      const horseId = String(horse.horseId || "").trim() || null;
      return [{
        mark,
        number,
        horseName,
        horseId,
        horseMemo: horse.horseMemo == null ? null : horse.horseMemo,
        netkeibaMemoSync: horse.netkeibaMemoSync == null ? null : horse.netkeibaMemoSync
      }];
    });

    const race = {
      id: createStableId(raceName, raceTime),
      date: String(source.date || "").trim(),
      raceId: identity.raceId,
      raceName,
      raceTime: raceTime.padStart(5, "0"),
      raceUrl: identity.raceUrl,
      raceLabel: String(source.raceLabel || "").trim(),
      marks,
      rating: { expectation: 0, fieldLevel: 0, value: 0 },
      betPlan: source.betPlan == null ? null : source.betPlan,
      raceResult: source.raceResult == null ? null : source.raceResult,
      analysis: source.analysis == null ? null : source.analysis
    };
    const sourceRating = source.ratings && typeof source.ratings === "object" ? source.ratings : source.rating;
    if (sourceRating && typeof sourceRating === "object") {
      race.rating.expectation = window.ShinbaRating.clamp(sourceRating.expectation);
      race.rating.fieldLevel = window.ShinbaRating.clamp(
        Object.prototype.hasOwnProperty.call(sourceRating, "fieldLevel")
          ? sourceRating.fieldLevel
          : sourceRating.level
      );
      race.rating.value = window.ShinbaRating.clamp(sourceRating.value);
    }
    const validation = window.ShinbaValidation.validateRaceMarks(race, window.ShinbaData.ALL_MARKS);
    if (!validation.isValid) {
      const duplicate = marks.filter((entry) => entry.mark === "◎").length > 1;
      throw new RaceImportError(duplicate ? "DUPLICATE_HONMEI" : "NO_VALID_MARKS", validation.errors[0]);
    }
    return race;
  }

  function toExternalRace(race) {
    return {
      date: race.date || "",
      raceId: race.raceId || null,
      raceName: race.raceName,
      raceTime: race.raceTime,
      raceUrl: race.raceUrl || "",
      raceLabel: race.raceLabel || "",
      horses: race.marks.map((entry) => ({
        horseId: entry.horseId || null,
        number: entry.number,
        name: entry.horseName,
        mark: entry.mark === "○" ? "◯" : entry.mark,
        horseMemo: entry.horseMemo == null ? null : entry.horseMemo,
        netkeibaMemoSync: entry.netkeibaMemoSync == null ? null : entry.netkeibaMemoSync
      })),
      rating: {
        expectation: race.rating.expectation,
        level: race.rating.fieldLevel,
        value: race.rating.value
      },
      betPlan: race.betPlan == null ? null : race.betPlan,
      raceResult: race.raceResult == null ? null : race.raceResult,
      analysis: race.analysis == null ? null : race.analysis
    };
  }

  window.ShinbaImport = {
    RaceImportError,
    normalizeMark,
    buildRaceUrl,
    resolveRaceIdentity,
    createStableId,
    importRaceData,
    toExternalRace
  };
}());
