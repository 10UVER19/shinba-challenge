(function () {
  "use strict";

  const PROVIDERS = Object.freeze([
    { id: "ipat", label: "即PAT" },
    { id: "umaca", label: "UMACA" }
  ]);
  const BET_TYPES = Object.freeze(["単勝", "複勝", "枠連", "馬連", "ワイド", "馬単", "三連複", "三連単"]);

  class BetPlanError extends Error {
    constructor(type, message, details) {
      super(message);
      this.name = "BetPlanError";
      this.type = type;
      this.details = details || null;
    }
  }

  function isoNow() { return new Date().toISOString(); }

  function create(raceId) {
    return { raceId: String(raceId || ""), provider: null, status: "draft", bets: [], totalAmount: 0, createdAt: isoNow(), confirmedAt: null, purchasedAt: null, purchaseId: null };
  }

  function normalizeNumbers(value) {
    const source = Array.isArray(value) ? value : String(value || "").split(/[、,\s-]+/);
    const numbers = source.filter((item) => String(item).trim() !== "").map(Number);
    if (numbers.some((number) => !Number.isInteger(number) || number < 1 || number > 18)) {
      throw new BetPlanError("INVALID_BET_NUMBER", "馬番は1〜18で指定してください。");
    }
    return Array.from(new Set(numbers));
  }

  function requiredNumberCount(type) {
    if (["単勝", "複勝"].includes(type)) return 1;
    if (["枠連", "馬連", "ワイド", "馬単"].includes(type)) return 2;
    return 3;
  }

  function normalize(input, expectedRaceId) {
    if (input == null) return null;
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new BetPlanError("INVALID_BET_PLAN", "買い目データが正しくありません。");
    const raceId = String(input.raceId || expectedRaceId || "").trim();
    if (!/^\d{12}$/.test(raceId) || (expectedRaceId && raceId !== expectedRaceId)) {
      throw new BetPlanError("INVALID_BET_RACE", "買い目のraceIdが正しくありません。");
    }
    const provider = input.provider == null || input.provider === "" ? null : String(input.provider);
    if (provider && !PROVIDERS.some((item) => item.id === provider)) throw new BetPlanError("INVALID_PROVIDER", "投票先が正しくありません。");
    const bets = (Array.isArray(input.bets) ? input.bets : []).map((bet, index) => {
      const type = String(bet && bet.type || "");
      if (!BET_TYPES.includes(type)) throw new BetPlanError("INVALID_BET_TYPE", `${index + 1}件目の式別が正しくありません。`);
      const numbers = normalizeNumbers(bet.numbers);
      if (numbers.length !== requiredNumberCount(type)) throw new BetPlanError("INVALID_BET_NUMBERS", `${type}の馬番数が正しくありません。`);
      const amount = Number(bet.amount);
      if (!Number.isInteger(amount) || amount < 100 || amount % 100 !== 0) throw new BetPlanError("INVALID_BET_AMOUNT", "金額は100円単位で指定してください。");
      return { type, numbers, amount };
    });
    const totalAmount = bets.reduce((sum, bet) => sum + bet.amount, 0);
    const status = ["draft", "confirmed", "purchased", "unknown"].includes(input.status) ? input.status : "draft";
    return {
      raceId,
      provider,
      status,
      bets,
      totalAmount,
      createdAt: input.createdAt || isoNow(),
      confirmedAt: input.confirmedAt || null,
      purchasedAt: input.purchasedAt || null,
      purchaseId: input.purchaseId || null
    };
  }

  function validateLimits(plan, dayPlans, settings) {
    const normalized = normalize(plan, plan && plan.raceId);
    if (!normalized || normalized.bets.length === 0) throw new BetPlanError("NO_BETS", "買い目を1件以上追加してください。");
    if (!normalized.provider) throw new BetPlanError("PROVIDER_REQUIRED", "即PATまたはUMACAを選択してください。");
    if (normalized.totalAmount > settings.maxPerRace) throw new BetPlanError("RACE_LIMIT_EXCEEDED", "1レースの購入上限を超えています。");
    const dayTotal = (dayPlans || []).reduce((sum, item) => sum + Number(item && item.totalAmount || 0), 0);
    if (dayTotal > settings.maxPerDay) throw new BetPlanError("DAY_LIMIT_EXCEEDED", "1日の購入上限を超えています。");
    return normalized;
  }

  function confirm(plan, dayPlans, settings) {
    const normalized = validateLimits(plan, dayPlans, settings);
    return { ...normalized, status: "confirmed", confirmedAt: isoNow(), purchasedAt: null, purchaseId: null };
  }

  const adapters = Object.freeze({
    ipat: { id: "ipat", label: "即PAT", available: false, prepare() { throw new BetPlanError("PROVIDER_NOT_VERIFIED", "即PATの購入アダプタは実機仕様未確認のため無効です。"); } },
    umaca: { id: "umaca", label: "UMACA", available: false, prepare() { throw new BetPlanError("PROVIDER_NOT_VERIFIED", "UMACAの購入アダプタは実機仕様未確認のため無効です。"); } }
  });

  window.ShinbaBetPlan = { PROVIDERS, BET_TYPES, BetPlanError, create, normalize, normalizeNumbers, validateLimits, confirm, adapters };
}());
