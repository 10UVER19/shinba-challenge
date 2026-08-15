(function () {
  "use strict";

  class NewcomerListError extends Error {
    constructor(type, message, details) {
      super(message);
      this.name = "NewcomerListError";
      this.type = type;
      this.details = details || null;
    }
  }

  function unwrapPayload(input) {
    let payload = input;
    if (typeof payload === "string") {
      try {
        payload = JSON.parse(payload);
      } catch (error) {
        throw new NewcomerListError("INVALID_JSON", "JSONの形式が正しくありません。");
      }
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new NewcomerListError("INVALID_PAYLOAD", "新馬戦一覧のJSONオブジェクトを指定してください。");
    }
    if (payload.success === false) {
      const sourceError = payload.error || {};
      throw new NewcomerListError(sourceError.type || "EXPORT_ERROR", sourceError.message || "新馬戦一覧の取得に失敗しました。", sourceError.details);
    }
    return payload.success === true && payload.data ? payload.data : payload;
  }

  function getRaceKey(race) {
    return String(race.raceId || race.raceUrl || `${race.raceName}-${race.raceTime}`);
  }

  function normalizeRace(source, index) {
    const raceName = String(source && source.raceName || "").trim();
    const raceTime = String(source && source.raceTime || "").trim().padStart(5, "0");
    if (!raceName) throw new NewcomerListError("RACE_NAME_NOT_FOUND", `${index + 1}件目のraceNameがありません。`);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raceTime)) {
      throw new NewcomerListError("INVALID_RACE_TIME", `${raceName}のraceTimeが正しくありません。`);
    }
    let identity;
    try {
      identity = window.ShinbaImport.resolveRaceIdentity(source, { required: true });
    } catch (error) {
      throw new NewcomerListError(
        error.type || "INVALID_RACE_URL",
        `${raceName}のraceId / raceUrlが正しくありません。`,
        error.details
      );
    }
    return {
      raceName,
      raceTime,
      raceUrl: identity.raceUrl,
      raceId: identity.raceId,
      raceLabel: String(source.raceLabel || "").trim()
    };
  }

  function importNewcomerList(input) {
    const source = unwrapPayload(input);
    const date = String(source.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new NewcomerListError("INVALID_DATE", "dateはYYYY-MM-DD形式で指定してください。");
    }
    if (!Array.isArray(source.races)) {
      throw new NewcomerListError("RACE_LIST_NOT_FOUND", "races配列がありません。");
    }

    const seen = new Set();
    const races = source.races.map(normalizeRace).filter((race) => {
      const key = getRaceKey(race);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).sort((a, b) => a.raceTime.localeCompare(b.raceTime));
    return { date, races };
  }

  function parseJsonDocuments(input) {
    const text = String(input || "").trim();
    if (!text) throw new NewcomerListError("INVALID_JSON", "新馬戦一覧JSONを入力してください。");

    try {
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      const documents = [];
      let start = -1;
      let depth = 0;
      let inString = false;
      let escaped = false;

      for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        if (start < 0) {
          if (/\s|,/.test(character)) continue;
          if (character !== "{" && character !== "[") {
            throw new NewcomerListError("INVALID_JSON", "複数JSONは改行で区切るか、JSON配列として入力してください。");
          }
          start = index;
          depth = 1;
          continue;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === "\"") inString = false;
          continue;
        }
        if (character === "\"") inString = true;
        else if (character === "{" || character === "[") depth += 1;
        else if (character === "}" || character === "]") depth -= 1;

        if (depth === 0) {
          try {
            const parsed = JSON.parse(text.slice(start, index + 1));
            documents.push(...(Array.isArray(parsed) ? parsed : [parsed]));
          } catch (error) {
            throw new NewcomerListError("INVALID_JSON", "JSONの形式が正しくありません。");
          }
          start = -1;
        }
      }
      if (start >= 0 || documents.length === 0) {
        throw new NewcomerListError("INVALID_JSON", "JSONの形式が正しくありません。");
      }
      return documents;
    }
  }

  function mergeNewcomerLists(input) {
    const payloads = typeof input === "string"
      ? parseJsonDocuments(input)
      : (Array.isArray(input) ? input : [input]);
    if (payloads.length === 0) {
      throw new NewcomerListError("EMPTY_LIST_INPUT", "統合する新馬戦一覧JSONがありません。");
    }

    const lists = payloads.map(importNewcomerList);
    const dates = [...new Set(lists.map((list) => list.date))];
    if (dates.length !== 1) {
      throw new NewcomerListError(
        "DATE_MISMATCH",
        `対象日が一致しないJSONは統合できません（${dates.join(" / ")}）。`,
        { dates }
      );
    }

    const seenRaceIds = new Set();
    const races = lists.flatMap((list) => list.races).filter((race) => {
      const key = race.raceId ? `raceId:${race.raceId}` : `fallback:${getRaceKey(race)}`;
      if (seenRaceIds.has(key)) return false;
      seenRaceIds.add(key);
      return true;
    }).sort((a, b) => a.raceTime.localeCompare(b.raceTime));
    return { date: dates[0], races };
  }

  window.ShinbaNewcomer = {
    NewcomerListError,
    getRaceKey,
    importNewcomerList,
    mergeNewcomerLists
  };
}());
