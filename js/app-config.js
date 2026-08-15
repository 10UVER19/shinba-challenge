(function () {
  "use strict";

  const STORAGE_KEY = "shinba-challenge-v2-settings";
  const APP_ID = "shinba-challenge";
  const PRODUCTION_ORIGIN = "https://10uver19.github.io";
  const PRODUCTION_APP_URL = `${PRODUCTION_ORIGIN}/shinba-challenge/`;
  const DEFAULT_MEMO_TEMPLATE = [
    "{{dateSlash}} {{raceName}}",
    "印：{{mark}}",
    "期待度：{{expectationStars}}",
    "出走馬レベル：{{levelStars}}",
    "配当妙味：{{valueStars}}"
  ].join("\n");
  const DEFAULTS = Object.freeze({
    productionWebUrl: PRODUCTION_APP_URL,
    pythonistaScriptPath: "shinba_challenge.py",
    memoTemplate: DEFAULT_MEMO_TEMPLATE,
    perfectRatingRainbow: true,
    maxPerRace: 10000,
    maxPerDay: 30000
  });

  function normalizeHttpsUrl(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const parsed = new URL(text);
    if (parsed.protocol !== "https:") throw new Error("本番Web URLはhttps://で指定してください。");
    parsed.username = "";
    parsed.password = "";
    parsed.hash = "";
    return parsed.href;
  }

  function normalizeScriptPath(value) {
    const path = String(value || "").trim().replace(/^\/+/, "");
    if (!/^[A-Za-z0-9_.\/-]+\.py$/.test(path) || path.includes("..")) {
      throw new Error("Pythonista script pathが正しくありません。");
    }
    return path;
  }

  function normalizeLimit(value, fallback) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 100 || number > 10000000 || number % 100 !== 0) return fallback;
    return number;
  }

  function normalize(input) {
    const source = input && typeof input === "object" ? input : {};
    return {
      productionWebUrl: normalizeHttpsUrl(source.productionWebUrl || DEFAULTS.productionWebUrl),
      pythonistaScriptPath: normalizeScriptPath(source.pythonistaScriptPath || DEFAULTS.pythonistaScriptPath),
      memoTemplate: String(source.memoTemplate || DEFAULTS.memoTemplate).slice(0, 2000),
      perfectRatingRainbow: source.perfectRatingRainbow !== false,
      maxPerRace: normalizeLimit(source.maxPerRace, DEFAULTS.maxPerRace),
      maxPerDay: normalizeLimit(source.maxPerDay, DEFAULTS.maxPerDay)
    };
  }

  function load() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      return normalize(raw ? JSON.parse(raw) : DEFAULTS);
    } catch (error) {
      console.warn("設定を復元できないため既定値を使用します。", error);
      return { ...DEFAULTS };
    }
  }

  function save(settings) {
    const normalized = normalize(settings);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  }

  function getCurrentReturnUrl() {
    const url = new URL(window.location.href);
    if (url.origin === PRODUCTION_ORIGIN) return PRODUCTION_APP_URL;
    url.searchParams.delete("pythonistaResult");
    url.hash = "";
    return url.href;
  }

  function getPythonistaRunUrl(settings) {
    return `pythonista3://${normalizeScriptPath((settings || load()).pythonistaScriptPath)}?action=run`;
  }

  window.ShinbaConfig = {
    APP_ID,
    PRODUCTION_ORIGIN,
    PRODUCTION_APP_URL,
    STORAGE_KEY,
    DEFAULTS,
    DEFAULT_MEMO_TEMPLATE,
    normalize,
    load,
    save,
    getCurrentReturnUrl,
    getPythonistaRunUrl
  };
}());
