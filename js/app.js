(function () {
  "use strict";

  const STORAGE_KEY = "shinba-challenge-step1-v1";
  const STORAGE_SCHEMA_VERSION = 1;
  const PYTHONISTA_RETURN_PARAMETER = "pythonistaResult";
  const PYTHONISTA_ACTIONS = Object.freeze({
    newcomerList: "collectNewcomerList",
    selectedRaces: "collectSelectedRaces",
    horseMemos: "syncHorseMemos"
  });
  const app = document.getElementById("app");
  const networkStatus = document.getElementById("network-status");
  const dialog = document.getElementById("zero-rating-dialog");
  const dialogCancel = document.getElementById("dialog-cancel");
  const dialogConfirm = document.getElementById("dialog-confirm");
  const resetDataButton = document.getElementById("reset-day-data-button");
  const resetDialog = document.getElementById("reset-data-dialog");
  const resetDialogCancel = document.getElementById("reset-dialog-cancel");
  const resetDialogConfirm = document.getElementById("reset-dialog-confirm");
  const { races, DISPLAY_MARKS, ALL_MARKS, RATING_FIELDS } = window.ShinbaData;
  const initialRaces = races.map((race) => ({
    ...race,
    marks: race.marks.map((entry) => ({ ...entry })),
    rating: { ...race.rating }
  }));
  let currentIndex = 0;
  let view = "home";
  let pendingAction = null;
  let importedRaceSources = [];
  let importMessage = null;
  let newcomerDate = "";
  let newcomerRaces = [];
  let selectedRaceKeys = [];
  let selectedRaces = [];
  let newcomerImportMessage = null;
  let selectionMessage = null;
  let batchImportMessage = null;
  let batchProgress = [];
  let batchResultDraft = "";
  let isBatchImporting = false;
  let isPythonistaLaunching = false;
  let awaitingPythonistaResult = false;
  let activeBatchRequest = null;
  let batchCollectedSources = [];
  let batchPendingErrors = [];
  let processedResultFingerprint = "";
  let pythonistaReturnNoticeShown = false;
  let awaitingNewcomerList = false;
  let awaitingGenericPythonistaResult = false;
  let isNewcomerLaunching = false;
  let isNewcomerImporting = false;
  let newcomerAutomationMessage = null;
  let newcomerReturnNoticeShown = false;
  let isStoryRendering = false;
  let historyRecords = [];
  let historyMessage = null;
  let historyReady = false;
  let historySaveTimer = null;
  let activeHistoryDate = "";
  let activeHistoryRecord = null;
  let isHistoricalSession = false;
  let isHistoryBusy = false;
  let appSettings = window.ShinbaConfig.load();
  let awaitingMemoSync = false;
  let isMemoSyncBusy = false;
  let memoSyncMessage = null;
  let memoSyncRequest = null;
  let betPlanRaceIndex = 0;
  let betPlanMessage = null;
  let betConfirmationOpen = false;

  function todayIso() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  let storyMeta = { date: todayIso(), memo: "" };

  function workingDate() {
    return activeHistoryDate || storyMeta.date || newcomerDate || todayIso();
  }

  function withReturnContext(request) {
    const returnUrl = window.ShinbaConfig.getCurrentReturnUrl();
    return { ...request, appId: window.ShinbaConfig.APP_ID, returnUrl, returnOrigin: new URL(returnUrl).origin };
  }

  function pythonistaRunUrl() {
    return window.ShinbaConfig.getPythonistaRunUrl(appSettings);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;"
    }[character]));
  }

  function createUiError(userMessage, error) {
    console.error(userMessage, error);
    return {
      type: "error",
      text: userMessage,
      detail: `[${error && error.type || "UNEXPECTED_ERROR"}] ${error && error.message || "予期しないエラーが発生しました。"}`
    };
  }

  function messageDetailHtml(message) {
    if (!message || !message.detail) return "";
    return `<details class="error-detail"><summary>詳細を見る</summary><p>${escapeHtml(message.detail)}</p></details>`;
  }

  function restoreUiMessage(value) {
    if (!value || typeof value !== "object" || typeof value.text !== "string") return null;
    const type = ["info", "success", "error"].includes(value.type) ? value.type : "info";
    return {
      type,
      text: value.text.slice(0, 240),
      detail: typeof value.detail === "string" ? value.detail.slice(0, 1000) : "",
      errors: Array.isArray(value.errors)
        ? value.errors.filter((item) => item && typeof item === "object").slice(0, 30)
        : undefined
    };
  }

  function resetInMemoryState() {
    races.splice(0, races.length, ...initialRaces.map((race) => ({
      ...race,
      marks: race.marks.map((entry) => ({ ...entry })),
      rating: { ...race.rating }
    })));
    currentIndex = 0;
    view = "home";
    pendingAction = null;
    importedRaceSources = [];
    importMessage = null;
    newcomerDate = "";
    newcomerRaces = [];
    selectedRaceKeys = [];
    selectedRaces = [];
    newcomerImportMessage = null;
    selectionMessage = null;
    storyMeta = { date: todayIso(), memo: "" };
    awaitingNewcomerList = false;
    awaitingGenericPythonistaResult = false;
    isNewcomerLaunching = false;
    isNewcomerImporting = false;
    newcomerAutomationMessage = null;
    newcomerReturnNoticeShown = false;
    isStoryRendering = false;
    activeHistoryDate = todayIso();
    activeHistoryRecord = null;
    isHistoricalSession = false;
    awaitingMemoSync = false;
    isMemoSyncBusy = false;
    memoSyncMessage = null;
    memoSyncRequest = null;
    betPlanRaceIndex = 0;
    betPlanMessage = null;
    betConfirmationOpen = false;
    clearBatchAutomationState();
  }

  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!saved) return;
      if (typeof saved !== "object" || Array.isArray(saved)) throw new Error("保存データの形式が正しくありません。");
      if (Array.isArray(saved.importedRaceSources) && saved.importedRaceSources.length > 0) {
        const restoredRaces = saved.importedRaceSources.map((source) => window.ShinbaImport.importRaceData(source));
        races.splice(0, races.length, ...restoredRaces.sort((a, b) => a.raceTime.localeCompare(b.raceTime)));
        importedRaceSources = restoredRaces.map(window.ShinbaImport.toExternalRace);
      }
      const savedRatings = saved.ratings || {};
      races.forEach((race) => {
        const rating = savedRatings[race.id];
        if (!rating) return;
        RATING_FIELDS.forEach(({ key }) => { race.rating[key] = window.ShinbaRating.clamp(rating[key]); });
      });
      if (saved.newcomerDate && Array.isArray(saved.newcomerList)) {
        const restoredList = window.ShinbaNewcomer.importNewcomerList({
          date: saved.newcomerDate,
          races: saved.newcomerList
        });
        newcomerDate = restoredList.date;
        newcomerRaces = restoredList.races;
        const availableKeys = new Set(newcomerRaces.map(window.ShinbaNewcomer.getRaceKey));
        selectedRaceKeys = Array.isArray(saved.selectedRaceKeys)
          ? saved.selectedRaceKeys.map(String).filter((key) => availableKeys.has(key))
          : [];
        updateSelectedRaces();
      }
      if (Number.isInteger(saved.currentIndex)) currentIndex = Math.max(0, Math.min(races.length - 1, saved.currentIndex));
      view = ["home", "input", "raceSelection", "raceBatch", "summary", "story", "settings", "memoSync", "betPlan"].includes(saved.view)
        ? saved.view
        : "home";
      awaitingPythonistaResult = saved.awaitingPythonistaResult === true && view === "raceBatch";
      awaitingNewcomerList = saved.awaitingNewcomerList === true && view === "home";
      awaitingGenericPythonistaResult = saved.awaitingGenericPythonistaResult === true && awaitingNewcomerList;
      newcomerAutomationMessage = restoreUiMessage(saved.newcomerAutomationMessage);
      batchImportMessage = restoreUiMessage(saved.batchImportMessage);
      activeBatchRequest = saved.activeBatchRequest && typeof saved.activeBatchRequest === "object"
        ? saved.activeBatchRequest
        : null;
      batchCollectedSources = Array.isArray(saved.batchCollectedSources)
        ? saved.batchCollectedSources.filter((item) => item && typeof item === "object")
        : [];
      batchProgress = Array.isArray(saved.batchProgress)
        ? saved.batchProgress.filter((item) => item && typeof item === "object")
        : [];
      batchPendingErrors = Array.isArray(saved.batchPendingErrors)
        ? saved.batchPendingErrors.filter((item) => item && typeof item === "object")
        : [];
      processedResultFingerprint = String(saved.processedResultFingerprint || "");
      if (saved.storyMeta) {
        storyMeta.date = /^\d{4}-\d{2}-\d{2}$/.test(String(saved.storyMeta.date || ""))
          ? saved.storyMeta.date
          : storyMeta.date;
        storyMeta.memo = String(saved.storyMeta.memo || "").slice(0, 40);
      }
      activeHistoryDate = /^\d{4}-\d{2}-\d{2}$/.test(String(saved.activeHistoryDate || ""))
        ? String(saved.activeHistoryDate)
        : storyMeta.date;
      isHistoricalSession = saved.isHistoricalSession === true;
      awaitingMemoSync = saved.awaitingMemoSync === true && view === "memoSync";
      memoSyncMessage = restoreUiMessage(saved.memoSyncMessage);
      memoSyncRequest = saved.memoSyncRequest && typeof saved.memoSyncRequest === "object" ? saved.memoSyncRequest : null;
      betPlanRaceIndex = Number.isInteger(saved.betPlanRaceIndex) ? Math.max(0, saved.betPlanRaceIndex) : 0;
    } catch (error) {
      console.warn("保存データを復元できませんでした。安全な初期状態へ戻します。", error);
      try { localStorage.removeItem(STORAGE_KEY); } catch (storageError) { console.warn(storageError); }
      resetInMemoryState();
    }
  }

  function save() {
    const ratings = Object.fromEntries(races.map((race) => [race.id, { ...race.rating }]));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schemaVersion: STORAGE_SCHEMA_VERSION,
        ratings,
        currentIndex,
        view,
        storyMeta,
        importedRaceSources,
        newcomerDate,
        newcomerList: newcomerRaces,
        selectedRaceKeys,
        selectedRaces,
        awaitingNewcomerList,
        awaitingGenericPythonistaResult,
        newcomerAutomationMessage,
        awaitingPythonistaResult,
        batchImportMessage,
        activeBatchRequest,
        batchCollectedSources,
        batchProgress,
        batchPendingErrors,
        processedResultFingerprint,
        activeHistoryDate,
        isHistoricalSession,
        awaitingMemoSync,
        memoSyncMessage,
        memoSyncRequest,
        betPlanRaceIndex
      }));
    } catch (error) {
      console.warn("入力内容をlocalStorageへ保存できませんでした。", error);
    }
    scheduleHistorySave();
  }

  function hasHistoryContent() {
    return importedRaceSources.length > 0 && races.length > 0 && /^\d{4}-\d{2}-\d{2}$/.test(workingDate());
  }

  async function persistActiveHistory() {
    if (!historyReady || !hasHistoryContent()) return null;
    const date = workingDate();
    try {
      const existing = activeHistoryRecord && activeHistoryRecord.date === date
        ? activeHistoryRecord
        : await window.ShinbaHistoryStore.getHistory(date);
      const record = window.ShinbaHistoryModel.createHistoryRecord({
        date,
        memo: storyMeta.memo,
        races,
        sources: importedRaceSources,
        existing
      });
      activeHistoryRecord = await window.ShinbaHistoryStore.putHistory(record);
      const summaryIndex = historyRecords.findIndex((item) => item.date === date);
      if (summaryIndex >= 0) historyRecords.splice(summaryIndex, 1, activeHistoryRecord);
      else historyRecords.push(activeHistoryRecord);
      historyRecords.sort((a, b) => b.date.localeCompare(a.date));
      return activeHistoryRecord;
    } catch (error) {
      console.error("日付別履歴を保存できませんでした。", error);
      historyMessage = createUiError("日付別履歴を保存できませんでした。", error);
      return null;
    }
  }

  function scheduleHistorySave() {
    if (!historyReady || !hasHistoryContent()) return;
    window.clearTimeout(historySaveTimer);
    historySaveTimer = window.setTimeout(() => {
      historySaveTimer = null;
      persistActiveHistory();
    }, 250);
  }

  async function flushHistorySave() {
    window.clearTimeout(historySaveTimer);
    historySaveTimer = null;
    return persistActiveHistory();
  }

  async function refreshHistoryRecords() {
    historyRecords = await window.ShinbaHistoryStore.listHistories();
  }

  function applyHistoryRecord(record) {
    const working = window.ShinbaHistoryModel.toWorkingState(record);
    const restoredRaces = working.sources.map((source) => window.ShinbaImport.importRaceData(source));
    restoredRaces.forEach((race, index) => {
      race.rating = { ...working.ratings[index] };
    });
    races.splice(0, races.length, ...restoredRaces);
    importedRaceSources = working.sources;
    currentIndex = 0;
    storyMeta = { date: working.date, memo: working.memo };
    activeHistoryDate = working.date;
    activeHistoryRecord = record;
    isHistoricalSession = true;
    newcomerDate = working.date;
    newcomerRaces = [];
    selectedRaceKeys = [];
    selectedRaces = [];
    clearBatchAutomationState();
    view = "summary";
  }

  async function openHistoryDate(date) {
    if (isHistoryBusy) return;
    isHistoryBusy = true;
    historyMessage = null;
    renderHome();
    try {
      const record = await window.ShinbaHistoryStore.getHistory(date);
      if (!record) throw new Error("選択した日付の履歴が見つかりません。");
      applyHistoryRecord(record);
      save();
      renderSummary();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      historyMessage = createUiError("過去の予想を開けませんでした。", error);
      renderHome();
    } finally {
      isHistoryBusy = false;
    }
  }

  async function returnHome() {
    await flushHistorySave();
    view = "home";
    save();
    renderHome();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function prepareTodayFlow() {
    if (!isHistoricalSession && workingDate() === todayIso()) return;
    resetInMemoryState();
    activeHistoryDate = todayIso();
    storyMeta.date = todayIso();
    try { localStorage.removeItem(STORAGE_KEY); } catch (error) { console.warn(error); }
  }

  function updateSelectedRaces() {
    const selected = new Set(selectedRaceKeys);
    selectedRaces = newcomerRaces
      .filter((race) => selected.has(window.ShinbaNewcomer.getRaceKey(race)))
      .sort((a, b) => a.raceTime.localeCompare(b.raceTime));
  }

  async function copyText(text, textarea) {
    if (navigator.clipboard && window.isSecureContext) {
      try {
        await Promise.race([
          navigator.clipboard.writeText(text),
          new Promise((resolve, reject) => window.setTimeout(
            () => reject(new Error("クリップボード書き込みがタイムアウトしました。")),
            2500
          ))
        ]);
        return;
      } catch (error) {
        console.warn("Clipboard APIから従来方式へ切り替えます。", error);
      }
    }
    const target = textarea || document.createElement("textarea");
    if (!textarea) {
      target.value = text;
      target.setAttribute("readonly", "");
      Object.assign(target.style, { position: "fixed", left: "-9999px", top: "0" });
      document.body.appendChild(target);
    }
    target.focus();
    target.select();
    target.setSelectionRange(0, target.value.length);
    const copied = document.execCommand("copy");
    if (!textarea) target.remove();
    if (!copied) throw new Error("クリップボードへコピーできませんでした。");
  }

  async function readClipboardText() {
    if (!navigator.clipboard || !window.isSecureContext || typeof navigator.clipboard.readText !== "function") {
      throw new Error("この環境ではクリップボードを直接読み取れません。下の入力欄へ貼り付けてください。");
    }
    return navigator.clipboard.readText();
  }

  function parsePythonistaResultEnvelope(text) {
    let payload;
    try {
      payload = JSON.parse(String(text || "").trim());
    } catch (error) {
      const invalid = new Error("Pythonista結果のJSON形式が正しくありません。");
      invalid.type = "INVALID_JSON";
      throw invalid;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      const invalid = new Error("Pythonista結果のJSONオブジェクトを指定してください。");
      invalid.type = "INVALID_PAYLOAD";
      throw invalid;
    }
    const action = String(payload.action || "").trim();
    if (!Object.values(PYTHONISTA_ACTIONS).includes(action)) {
      const invalid = new Error("Pythonista結果のactionを確認できません。もう一度Webアプリから処理を開始してください。");
      invalid.type = "UNSUPPORTED_ACTION";
      throw invalid;
    }
    return { action, payload };
  }

  function assertExpectedPythonistaAction(action, expected) {
    if (action === expected || awaitingGenericPythonistaResult) return;
    const invalid = new Error(`待機中の処理（${expected}）と取得結果（${action}）が一致しません。`);
    invalid.type = "PYTHONISTA_ACTION_MISMATCH";
    throw invalid;
  }

  function fingerprintText(text) {
    const source = String(text || "").trim();
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${source.length}:${(hash >>> 0).toString(16)}`;
  }

  function consumePythonistaReturnSignal() {
    try {
      const url = new URL(window.location.href);
      if (url.searchParams.get(PYTHONISTA_RETURN_PARAMETER) !== "1") return false;
      url.searchParams.delete(PYTHONISTA_RETURN_PARAMETER);
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      return true;
    } catch (error) {
      console.warn("Pythonista復帰URLを確認できませんでした。", error);
      return false;
    }
  }

  function raceSourceKey(race) {
    return String(race && race.raceId || "").trim()
      || `${String(race && race.raceName || "").trim()}\u0000${String(race && race.raceTime || "").trim()}`;
  }

  function clearBatchAutomationState() {
    awaitingPythonistaResult = false;
    activeBatchRequest = null;
    batchCollectedSources = [];
    batchPendingErrors = [];
    batchProgress = [];
    batchResultDraft = "";
    batchImportMessage = null;
    processedResultFingerprint = "";
    pythonistaReturnNoticeShown = false;
    isBatchImporting = false;
    isPythonistaLaunching = false;
  }

  async function resetDayData() {
    if (isHistoryBusy) return;
    isHistoryBusy = true;
    resetDialogConfirm.disabled = true;
    const targetDate = workingDate();
    window.clearTimeout(historySaveTimer);
    historySaveTimer = null;
    try {
      if (historyReady) await window.ShinbaHistoryStore.deleteHistory(targetDate);
      try { localStorage.removeItem(STORAGE_KEY); } catch (error) { console.warn("保存データを削除できませんでした。", error); }
      resetInMemoryState();
      if (historyReady) await refreshHistoryRecords();
      historyMessage = { type: "success", text: `${historyDateLabel(targetDate)}の作業データをリセットしました。` };
    } catch (error) {
      historyMessage = createUiError(`${historyDateLabel(targetDate)}の作業データをリセットできませんでした。`, error);
    } finally {
      isHistoryBusy = false;
      resetDialogConfirm.disabled = false;
      dialog.hidden = true;
      resetDialog.hidden = true;
      document.body.style.overflow = "";
      document.body.classList.remove("story-mode");
      renderHome();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  function getActiveBatchRequest() {
    if (activeBatchRequest) {
      try {
        return withReturnContext(window.ShinbaBatch.buildPythonistaRequest(
          activeBatchRequest.date,
          activeBatchRequest.selectedRaces
        ));
      } catch (error) {
        console.warn("保存されたPythonista入力を復元できませんでした。", error);
        activeBatchRequest = null;
      }
    }
    return withReturnContext(window.ShinbaBatch.buildPythonistaRequest(newcomerDate, selectedRaces));
  }

  function mergeCollectedSources(sources) {
    const merged = new Map(batchCollectedSources.map((source) => [raceSourceKey(source), source]));
    sources.forEach((source) => merged.set(raceSourceKey(source), source));
    batchCollectedSources = Array.from(merged.values())
      .sort((a, b) => String(a.raceTime).localeCompare(String(b.raceTime)));
  }

  function getMissingSelectedRaces() {
    const collectedKeys = new Set(batchCollectedSources.map(raceSourceKey));
    return selectedRaces.filter((race) => !collectedKeys.has(raceSourceKey(race)));
  }

  function refreshCombinedProgress(activeProgress) {
    const collectedKeys = new Set(batchCollectedSources.map(raceSourceKey));
    const activeByKey = new Map(activeProgress.map((item) => [raceSourceKey(item), item]));
    const previousByKey = new Map(batchProgress.map((item) => [raceSourceKey(item), item]));
    batchProgress = selectedRaces.map((race) => {
      const key = raceSourceKey(race);
      if (collectedKeys.has(key)) return { ...race, status: "success" };
      return activeByKey.get(key) || previousByKey.get(key) || { ...race, status: "waiting" };
    });
    batchPendingErrors = batchProgress
      .filter((item) => item.status === "error" && item.error)
      .map((item) => item.error);
  }

  function visibleMarks(race) {
    return DISPLAY_MARKS.flatMap((mark) => race.marks.filter((entry) => entry.mark === mark));
  }

  function marksHtml(race) {
    return visibleMarks(race).map((entry) => `
      <li class="mark-row">
        <span class="mark-symbol">${escapeHtml(entry.mark)}</span>
        <span class="horse-number">${escapeHtml(entry.number)}</span>
        <span class="horse-name">${escapeHtml(entry.horseName)}</span>
      </li>`).join("");
  }

  function starControl(field, value) {
    const stars = Array.from({ length: 5 }, (_, index) => `<span class="star${index < value ? " is-filled" : ""}" aria-hidden="true">${index < value ? "★" : "☆"}</span>`).join("");
    return `<div class="star-rating" data-rating-key="${field.key}" role="slider" tabindex="0" aria-label="${field.label}" aria-valuemin="0" aria-valuemax="5" aria-valuenow="${value}" aria-valuetext="${window.ShinbaRating.toStars(value)}">${stars}</div>`;
  }

  function importPanelHtml() {
    const status = importMessage
      ? `<div class="import-status ${importMessage.type === "success" ? "is-success" : "is-error"}" role="status"><p>${escapeHtml(importMessage.text)}</p>${messageDetailHtml(importMessage)}</div>`
      : "";
    return `<details class="import-panel"${importMessage ? " open" : ""}>
      <summary>1レースJSONを手動で読み込む</summary>
      <div class="import-panel-body">
        <p class="import-description">通常導線で取得できない場合の確認用です。1レース分のJSONを貼り付けます。</p>
        <textarea id="race-json-input" class="json-input" aria-label="1レース分のJSON" placeholder='{"success":true,"data":{"raceName":"新潟5R","raceTime":"12:30","horses":[...]}}'></textarea>
        <div class="import-actions"><button id="import-json-button" class="button button-secondary button-small" type="button">JSONを読み込む</button></div>
        ${status}
      </div>
    </details>`;
  }

  function newcomerImportPanelHtml() {
    const status = newcomerImportMessage
      ? `<div class="import-status ${newcomerImportMessage.type === "success" ? "is-success" : "is-error"}" role="status"><p>${escapeHtml(newcomerImportMessage.text)}</p>${messageDetailHtml(newcomerImportMessage)}</div>`
      : "";
    const reopenButton = newcomerRaces.length > 0
      ? `<button id="open-race-selection-button" class="button button-secondary button-small" type="button">保存した一覧を開く（${newcomerRaces.length}レース）</button>`
      : "";
    return `<details class="import-panel"${newcomerImportMessage ? " open" : ""}>
      <summary>新馬戦一覧JSONを手動で読み込む</summary>
      <div class="import-panel-body">
        <p class="import-description">Pythonista連携が使えない場合の予備です。同日のJSON配列や改行区切りにも対応しています。</p>
        <textarea id="newcomer-json-input" class="json-input" aria-label="複数開催場の新馬戦一覧JSON" placeholder='{"success":true,"date":"2026-08-08","races":[...]}&#10;{"success":true,"date":"2026-08-08","races":[...]}'></textarea>
        <div class="import-actions">
          ${reopenButton}
          <button id="import-newcomer-json-button" class="button button-primary button-small" type="button">一覧を統合して読み込む</button>
        </div>
        ${status}
      </div>
    </details>`;
  }

  function applyNewcomerList(importedList) {
    const isSameDate = importedList.date === newcomerDate;
    const availableKeys = new Set(importedList.races.map(window.ShinbaNewcomer.getRaceKey));
    selectedRaceKeys = isSameDate
      ? selectedRaceKeys.filter((key) => availableKeys.has(key))
      : [];
    newcomerDate = importedList.date;
    storyMeta.date = importedList.date;
    activeHistoryDate = importedList.date;
    activeHistoryRecord = null;
    isHistoricalSession = false;
    newcomerRaces = importedList.races;
    updateSelectedRaces();
    awaitingNewcomerList = false;
    awaitingGenericPythonistaResult = false;
    isNewcomerLaunching = false;
    isNewcomerImporting = false;
    newcomerAutomationMessage = null;
    clearBatchAutomationState();
    view = "raceSelection";
    newcomerImportMessage = null;
    selectionMessage = null;
    save();
    renderRaceSelection();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function startNewcomerListFlow() {
    if (isNewcomerLaunching || isNewcomerImporting || awaitingNewcomerList) return;
    prepareTodayFlow();
    awaitingGenericPythonistaResult = false;
    isNewcomerLaunching = true;
    newcomerReturnNoticeShown = false;
    newcomerAutomationMessage = { type: "info", text: "Pythonistaで当日の新馬戦一覧を取得します…" };
    view = "home";
    save();
    renderHome();

    try {
      await copyText(JSON.stringify(withReturnContext({
        action: PYTHONISTA_ACTIONS.newcomerList,
        date: todayIso()
      })));
      awaitingNewcomerList = true;
      isNewcomerLaunching = false;
      newcomerAutomationMessage = {
        type: "info",
        text: "Pythonistaを起動しました。完了後、自動的にSafariへ戻ります。"
      };
      save();
      renderHome();
      window.location.assign(pythonistaRunUrl());
    } catch (error) {
      isNewcomerLaunching = false;
      awaitingNewcomerList = false;
      newcomerAutomationMessage = createUiError("新馬戦一覧の取得を開始できませんでした。", error);
      save();
      renderHome();
    }
  }

  async function readNewcomerListFromClipboard() {
    if (isNewcomerImporting || isNewcomerLaunching) return;
    isNewcomerImporting = true;
    newcomerAutomationMessage = { type: "info", text: "新馬戦一覧を読み込んでいます…" };
    renderHome();
    try {
      const clipboardText = await readClipboardText();
      const envelope = parsePythonistaResultEnvelope(clipboardText);
      if (envelope.action === PYTHONISTA_ACTIONS.selectedRaces) {
        assertExpectedPythonistaAction(envelope.action, PYTHONISTA_ACTIONS.newcomerList);
        if (recoverPythonistaRaceResult(clipboardText)) return;
      }
      if (envelope.action === PYTHONISTA_ACTIONS.horseMemos) {
        assertExpectedPythonistaAction(envelope.action, PYTHONISTA_ACTIONS.newcomerList);
        await applyMemoSyncResult(envelope.payload);
        view = "memoSync";
        isNewcomerImporting = false;
        renderMemoSync();
        return;
      }
      assertExpectedPythonistaAction(envelope.action, PYTHONISTA_ACTIONS.newcomerList);
      const importedList = window.ShinbaNewcomer.importNewcomerList(envelope.payload);
      applyNewcomerList(importedList);
    } catch (error) {
      isNewcomerImporting = false;
      newcomerAutomationMessage = createUiError(
        "新馬戦一覧を読み込めませんでした。もう一度試すか、トラブル時の入力欄を使用してください。",
        error
      );
      save();
      renderHome();
    }
  }

  function recoverPythonistaRaceResult(text) {
    let payload;
    try {
      payload = window.ShinbaBatch.validatePythonistaResultPayload(text);
    } catch (error) {
      return false;
    }
    const isRaceResult = payload.races.some((race) => Array.isArray(race.horses))
      || Array.isArray(payload.results)
      || Array.isArray(payload.errors);
    if (!isRaceResult) return false;

    const date = String(payload.date || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      const error = new Error("Pythonista完成結果の日付が正しくありません。");
      error.type = "INVALID_DATE";
      throw error;
    }
    if (awaitingGenericPythonistaResult || selectedRaces.length === 0) {
      const recovered = payload.races.map((race, index) => {
        const identity = window.ShinbaImport.resolveRaceIdentity(race, { required: true });
        const raceName = String(race.raceName || "").trim();
        const raceTime = String(race.raceTime || "").trim();
        if (!raceName || !/^([01]?\d|2[0-3]):[0-5]\d$/.test(raceTime)) {
          const error = new Error(`${index + 1}件目のraceName / raceTimeが正しくありません。`);
          error.type = "INVALID_RACE_RESULT";
          throw error;
        }
        return {
          raceName,
          raceTime,
          raceId: identity.raceId,
          raceUrl: identity.raceUrl,
          raceLabel: String(race.raceLabel || "").trim()
        };
      });
      if (recovered.length === 0) {
        const error = new Error("元のレース選択状態がなく、成功レースも復元できませんでした。");
        error.type = "PYTHONISTA_RESULT_CONTEXT_MISSING";
        throw error;
      }
      newcomerDate = date;
      newcomerRaces = recovered;
      selectedRaceKeys = recovered.map(window.ShinbaNewcomer.getRaceKey);
      updateSelectedRaces();
    }
    activeBatchRequest = window.ShinbaBatch.buildPythonistaRequest(date, selectedRaces);
    newcomerDate = date;
    storyMeta.date = date;
    activeHistoryDate = date;
    isHistoricalSession = false;
    awaitingNewcomerList = false;
    awaitingGenericPythonistaResult = false;
    isNewcomerImporting = false;
    newcomerAutomationMessage = null;
    view = "raceBatch";
    processPythonistaResultText(text);
    return true;
  }

  async function tryAutomaticPythonistaResultRead() {
    if (!navigator.clipboard || !window.isSecureContext || typeof navigator.clipboard.readText !== "function") return false;
    if (!awaitingMemoSync && !awaitingNewcomerList && !awaitingPythonistaResult) return false;

    try {
      const clipboardText = String(await navigator.clipboard.readText() || "").trim();
      if (!clipboardText) return false;
      const envelope = parsePythonistaResultEnvelope(clipboardText);
      if (envelope.action === PYTHONISTA_ACTIONS.selectedRaces) {
        assertExpectedPythonistaAction(envelope.action, PYTHONISTA_ACTIONS.selectedRaces);
        if (awaitingGenericPythonistaResult || selectedRaces.length === 0) {
          return recoverPythonistaRaceResult(clipboardText);
        }
        isBatchImporting = true;
        batchImportMessage = { type: "info", text: "Pythonistaの取得結果を自動で読み込んでいます…" };
        renderRaceBatch();
        batchResultDraft = clipboardText;
        isBatchImporting = false;
        processPythonistaResultText(clipboardText);
        return true;
      }

      if (envelope.action === PYTHONISTA_ACTIONS.horseMemos) {
        assertExpectedPythonistaAction(envelope.action, PYTHONISTA_ACTIONS.horseMemos);
        isMemoSyncBusy = true;
        memoSyncMessage = { type: "info", text: "同期結果を自動で読み込んでいます…" };
        view = "memoSync";
        renderMemoSync();
        await applyMemoSyncResult(envelope.payload);
        isMemoSyncBusy = false;
        renderMemoSync();
        return true;
      }

      assertExpectedPythonistaAction(envelope.action, PYTHONISTA_ACTIONS.newcomerList);
      isNewcomerImporting = true;
      newcomerAutomationMessage = { type: "info", text: "Pythonistaの取得結果を自動で読み込んでいます…" };
      renderHome();
      applyNewcomerList(window.ShinbaNewcomer.importNewcomerList(envelope.payload));
      return true;
    } catch (error) {
      isBatchImporting = false;
      isNewcomerImporting = false;
      isMemoSyncBusy = false;
      console.debug("Pythonista結果の自動読込は利用できませんでした。1タップ読込を表示します。", error);
      if (awaitingMemoSync) {
        memoSyncMessage = {
          type: "info",
          text: "Pythonistaから戻りました。「同期結果を読み込む」を押してください。"
        };
        save();
        renderMemoSync();
      } else if (awaitingPythonistaResult) {
        batchImportMessage = {
          type: "info",
          text: "Pythonistaから戻りました。「Pythonistaの取得結果を読み込む」を押してください。"
        };
        save();
        renderRaceBatch();
      } else if (awaitingNewcomerList) {
        newcomerAutomationMessage = {
          type: "info",
          text: "Pythonistaから戻りました。下の取得結果読込ボタンを押してください。"
        };
        save();
        renderHome();
      }
      return false;
    }
  }

  function historyDateLabel(date) {
    return String(date || "").replace(/-/g, "/");
  }

  async function exportHistoryBackup() {
    if (isHistoryBusy) return;
    isHistoryBusy = true;
    historyMessage = { type: "info", text: "履歴バックアップを準備しています…" };
    renderHome();
    try {
      const backup = await window.ShinbaHistoryStore.exportBackup();
      const json = `${JSON.stringify(backup, null, 2)}\n`;
      const filename = `shinba_challenge_backup_${todayIso()}.json`;
      const blob = new Blob([json], { type: "application/json" });
      const file = typeof File === "function" ? new File([blob], filename, { type: blob.type }) : null;
      if (file && navigator.share && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "新馬戦チャレンジ 履歴バックアップ" });
      } else {
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      historyMessage = { type: "success", text: `${backup.histories.length}日分のバックアップを書き出しました。` };
    } catch (error) {
      if (error && error.name === "AbortError") historyMessage = null;
      else historyMessage = createUiError("履歴バックアップを書き出せませんでした。", error);
    } finally {
      isHistoryBusy = false;
      renderHome();
    }
  }

  async function importHistoryBackup(file) {
    if (isHistoryBusy || !file) return;
    isHistoryBusy = true;
    historyMessage = { type: "info", text: "バックアップの形式を確認しています…" };
    renderHome();
    try {
      const text = await file.text();
      const validated = window.ShinbaHistoryModel.validateBackup(text);
      const confirmed = window.confirm(
        `${validated.histories.length}日分の履歴を読み込みます。\n同じ日付の履歴はバックアップ内容で更新され、その他の日付は残ります。\n\n復元しますか？`
      );
      if (!confirmed) {
        historyMessage = null;
        return;
      }
      const result = await window.ShinbaHistoryStore.importBackup(validated);
      await refreshHistoryRecords();
      historyMessage = { type: "success", text: `${result.importedCount}日分の履歴を復元しました。` };
    } catch (error) {
      historyMessage = createUiError("バックアップを読み込めませんでした。既存履歴は変更されていません。", error);
    } finally {
      isHistoryBusy = false;
      renderHome();
    }
  }

  function resumeWorkingSession() {
    if (importedRaceSources.length > 0 && races.length > 0) {
      view = "summary";
      save();
      renderSummary();
    } else if (newcomerRaces.length > 0) {
      view = "raceSelection";
      save();
      renderRaceSelection();
    } else {
      startNewcomerListFlow();
      return;
    }
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderHome() {
    document.body.classList.remove("story-mode");
    const controlsDisabled = isNewcomerLaunching || isNewcomerImporting || isHistoryBusy;
    const status = newcomerAutomationMessage
      ? `<div class="home-status is-${newcomerAutomationMessage.type}" role="${newcomerAutomationMessage.type === "error" ? "alert" : "status"}"><p>${escapeHtml(newcomerAutomationMessage.text)}</p>${messageDetailHtml(newcomerAutomationMessage)}</div>`
      : "";
    const primaryAction = awaitingNewcomerList
      ? `<button id="read-newcomer-result-button" class="button button-primary home-primary-button" type="button"${controlsDisabled ? " disabled" : ""}>${isNewcomerImporting ? "読み込んでいます…" : awaitingGenericPythonistaResult ? "Pythonistaの取得結果を読み込む" : "新馬戦一覧の取得結果を読み込む"}</button>`
      : `<button id="collect-newcomer-list-button" class="button button-primary home-primary-button" type="button"${controlsDisabled ? " disabled" : ""}>${isNewcomerLaunching ? "Pythonistaを起動しています…" : "今日の新馬戦を開始"}</button>`;
    const workingAction = hasHistoryContent()
      ? `<button id="resume-working-session-button" class="button button-secondary home-primary-button" type="button"${controlsDisabled ? " disabled" : ""}>作業中 ${escapeHtml(historyDateLabel(workingDate()))}　続きから</button>`
      : "";
    const savedListAction = newcomerRaces.length > 0 && !awaitingNewcomerList
      ? `<button id="resume-race-selection-button" class="button button-secondary" type="button">保存した一覧を開く（${newcomerRaces.length}レース）</button>`
      : "";

    const historyStatus = historyMessage
      ? `<div class="home-status is-${historyMessage.type}" role="${historyMessage.type === "error" ? "alert" : "status"}"><p>${escapeHtml(historyMessage.text)}</p>${messageDetailHtml(historyMessage)}</div>`
      : "";
    const historyItems = historyRecords.length > 0
      ? `<ul class="history-list">${historyRecords.map((record) => `
          <li><button class="history-date-button" type="button" data-history-date="${escapeHtml(record.date)}"${controlsDisabled ? " disabled" : ""}>
            <span class="history-date">${escapeHtml(historyDateLabel(record.date))}</span>
            <span class="history-count">${record.races.length}レース</span>
          </button></li>`).join("")}</ul>`
      : `<p class="history-empty">保存済みの予想はまだありません。</p>`;

    app.innerHTML = `
      <section class="home-start" aria-labelledby="home-start-title">
        <p class="home-step">START</p>
        <h2 id="home-start-title">当日の新馬戦から作成</h2>
        <p class="home-description">一覧取得からレース選択、評価、Story保存まで順番に進みます。</p>
        <div class="home-actions">${primaryAction}${workingAction}${savedListAction}</div>
        ${status}
        <ol class="home-flow" aria-label="通常利用の流れ">
          <li>新馬戦一覧を取得</li>
          <li>掲載レースを選択</li>
          <li>評価してPNG保存</li>
        </ol>
      </section>
      <section class="history-panel" aria-labelledby="history-title">
        <div class="history-heading">
          <div><p class="home-step">HISTORY</p><h2 id="history-title">過去の予想</h2></div>
          <span class="history-total">${historyRecords.length}日分</span>
        </div>
        ${historyItems}
        ${historyStatus}
      </section>
      <nav class="home-utility-actions" aria-label="アプリ管理">
        <button id="open-settings-button" class="button button-secondary" type="button">設定</button>
      </nav>
      <details class="backup-panel">
        <summary>履歴のバックアップ / 復元</summary>
        <div class="backup-panel-body">
          <p>全履歴をJSONで書き出します。復元時は先に形式を検証し、同じ日付だけを更新します。</p>
          <div class="backup-actions">
            <button id="export-history-button" class="button button-secondary button-small" type="button"${controlsDisabled ? " disabled" : ""}>バックアップを書き出す</button>
            <label class="button button-secondary button-small backup-file-button${controlsDisabled ? " is-disabled" : ""}">
              バックアップを読み込む
              <input id="import-history-input" type="file" accept="application/json,.json"${controlsDisabled ? " disabled" : ""}>
            </label>
          </div>
        </div>
      </details>
      <details class="trouble-panel"${newcomerAutomationMessage && newcomerAutomationMessage.type === "error" ? " open" : ""}>
        <summary>詳細 / トラブル時</summary>
        <div class="trouble-panel-body">
          <p>通常操作で進めない場合のみ、保存済みJSONの手動読込を利用してください。</p>
          ${newcomerImportPanelHtml()}
          ${importPanelHtml()}
        </div>
      </details>`;

    document.getElementById("collect-newcomer-list-button")?.addEventListener("click", startNewcomerListFlow);
    document.getElementById("resume-working-session-button")?.addEventListener("click", resumeWorkingSession);
    document.getElementById("read-newcomer-result-button")?.addEventListener("click", readNewcomerListFromClipboard);
    document.getElementById("resume-race-selection-button")?.addEventListener("click", () => {
      view = "raceSelection";
      save();
      renderRaceSelection();
    });
    app.querySelectorAll(".history-date-button").forEach((button) => {
      button.addEventListener("click", () => openHistoryDate(button.dataset.historyDate));
    });
    document.getElementById("export-history-button")?.addEventListener("click", exportHistoryBackup);
    document.getElementById("import-history-input")?.addEventListener("change", (event) => {
      const file = event.target.files && event.target.files[0];
      importHistoryBackup(file);
    });
    document.getElementById("open-settings-button")?.addEventListener("click", () => {
      view = "settings";
      save();
      renderSettings();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    bindImportPanel();
  }

  function renderSettings() {
    document.body.classList.remove("story-mode");
    const secureLabel = window.isSecureContext ? "HTTPS機能を利用できます" : "HTTP環境：Clipboard / Web Shareに制約があります";
    app.innerHTML = `
      <header class="selection-heading"><h2>設定</h2><p class="selection-date">認証ID・パスワードは保存しません</p></header>
      <form id="settings-form" class="settings-panel">
        <div class="form-field">
          <label for="production-web-url">本番Web URL</label>
          <input id="production-web-url" name="productionWebUrl" class="form-input" type="url" inputmode="url" value="${escapeHtml(appSettings.productionWebUrl)}" placeholder="https://10uver19.github.io/shinba-challenge/">
          <p class="field-help">本番公開URLの控えです。Pythonistaへの復帰URLは現在の実行環境から安全に生成します。</p>
        </div>
        <div class="form-field">
          <label for="pythonista-script-path">Pythonista script path</label>
          <input id="pythonista-script-path" name="pythonistaScriptPath" class="form-input" type="text" value="${escapeHtml(appSettings.pythonistaScriptPath)}">
        </div>
        <div class="form-field settings-wide-field">
          <label for="memo-template">netkeiba馬メモ テンプレート</label>
          <textarea id="memo-template" name="memoTemplate" class="json-input settings-template" maxlength="2000">${escapeHtml(appSettings.memoTemplate)}</textarea>
          <p class="field-help">同期識別用の開始・終了行は自動付与されます。利用可能：{{date}} {{dateSlash}} {{raceId}} {{raceName}} {{horseId}} {{horseName}} {{mark}} {{expectationStars}} {{levelStars}} {{valueStars}}</p>
        </div>
        <label class="settings-check"><input name="perfectRatingRainbow" type="checkbox"${appSettings.perfectRatingRainbow ? " checked" : ""}> ★5を静的な虹色で表示</label>
        <div class="settings-limit-grid">
          <div class="form-field"><label for="max-per-race">購入1レース上限（円）</label><input id="max-per-race" name="maxPerRace" class="form-input" type="number" min="100" step="100" value="${appSettings.maxPerRace}"></div>
          <div class="form-field"><label for="max-per-day">購入1日上限（円）</label><input id="max-per-day" name="maxPerDay" class="form-input" type="number" min="100" step="100" value="${appSettings.maxPerDay}"></div>
        </div>
        <p class="settings-environment ${window.isSecureContext ? "is-secure" : "is-insecure"}">${escapeHtml(secureLabel)}<br><small>${escapeHtml(window.location.origin)}</small></p>
        <div id="settings-message" class="home-status" hidden></div>
        <div class="summary-footer-actions">
          <button id="settings-back-button" class="button button-secondary" type="button">ホームへ戻る</button>
          <button class="button button-primary" type="submit">設定を保存</button>
        </div>
      </form>`;

    document.getElementById("settings-back-button").addEventListener("click", returnHome);
    document.getElementById("settings-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const message = document.getElementById("settings-message");
      try {
        appSettings = window.ShinbaConfig.save({
          productionWebUrl: form.get("productionWebUrl"),
          pythonistaScriptPath: form.get("pythonistaScriptPath"),
          memoTemplate: form.get("memoTemplate"),
          perfectRatingRainbow: form.get("perfectRatingRainbow") === "on",
          maxPerRace: form.get("maxPerRace"),
          maxPerDay: form.get("maxPerDay")
        });
        message.hidden = false;
        message.className = "home-status is-success";
        message.textContent = "設定を保存しました。";
      } catch (error) {
        message.hidden = false;
        message.className = "home-status is-error";
        message.textContent = error.message || "設定を保存できませんでした。";
      }
    });
  }

  function bindImportPanel() {
    document.getElementById("import-json-button")?.addEventListener("click", () => {
      const input = document.getElementById("race-json-input");
      try {
        const importedRace = window.ShinbaImport.importRaceData(input.value);
        races.splice(0, races.length, importedRace);
        importedRaceSources = [window.ShinbaImport.toExternalRace(importedRace)];
        activeHistoryDate = storyMeta.date;
        activeHistoryRecord = null;
        isHistoricalSession = false;
        currentIndex = 0;
        view = "input";
        importMessage = { type: "success", text: `${importedRace.raceName}を読み込みました。` };
        save();
        renderInput();
      } catch (error) {
        importMessage = createUiError("1レース分のデータを読み込めませんでした。", error);
        renderHome();
      }
    });

    document.getElementById("import-newcomer-json-button")?.addEventListener("click", () => {
      const input = document.getElementById("newcomer-json-input");
      try {
        const importedList = window.ShinbaNewcomer.mergeNewcomerLists(input.value);
        applyNewcomerList(importedList);
      } catch (error) {
        newcomerImportMessage = createUiError("新馬戦一覧JSONを読み込めませんでした。", error);
        renderHome();
      }
    });

    document.getElementById("open-race-selection-button")?.addEventListener("click", () => {
      view = "raceSelection";
      selectionMessage = null;
      save();
      renderRaceSelection();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function renderInput() {
    document.body.classList.remove("story-mode");
    const race = races[currentIndex];
    const markValidation = window.ShinbaValidation.validateRaceMarks(race, ALL_MARKS);
    if (!markValidation.isValid) console.warn(`${race.raceName}: ${markValidation.errors.join(" ")}`);

    app.innerHTML = `
      <div class="progress-row">
        <div class="progress-track" aria-hidden="true"><div class="progress-bar" style="width:${((currentIndex + 1) / races.length) * 100}%"></div></div>
        <span class="progress-label">${currentIndex + 1} / ${races.length}</span>
      </div>
      <article class="race-card">
        <header class="race-heading"><h2>${escapeHtml(race.raceName)}</h2><span class="race-time">発走 ${escapeHtml(race.raceTime)}</span></header>
        <ul class="marks-list" aria-label="予想印">${marksHtml(race)}</ul>
        <section class="ratings-panel" aria-label="星評価">
          ${RATING_FIELDS.map((field) => `<div class="rating-row"><span class="rating-label">${field.label}</span>${starControl(field, race.rating[field.key])}</div>`).join("")}
        </section>
      </article>
      <nav class="navigation" aria-label="レース移動">
        <button id="previous-button" class="button button-secondary" type="button" ${currentIndex === 0 ? "disabled" : ""}>戻る</button>
        <button id="next-button" class="button button-primary" type="button">${currentIndex === races.length - 1 ? "確認" : "次へ"}</button>
      </nav>
      <p class="save-note">評価はこのブラウザに自動保存されます</p>`;

    app.querySelectorAll(".star-rating").forEach((control) => {
      const key = control.dataset.ratingKey;
      window.ShinbaRating.bind(control, race.rating[key], (value) => {
        race.rating[key] = value;
        save();
      });
    });

    document.getElementById("previous-button").addEventListener("click", () => {
      currentIndex -= 1;
      save();
      renderInput();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.getElementById("next-button").addEventListener("click", requestAdvance);
  }

  function renderRaceSelection() {
    document.body.classList.remove("story-mode");
    updateSelectedRaces();
    const selected = new Set(selectedRaceKeys);
    const dateText = newcomerDate ? window.ShinbaStory.formatStoryDate(newcomerDate) : "日付未設定";
    const message = selectionMessage
      ? `<div class="selection-message ${selectionMessage.type === "success" ? "is-success" : "is-error"}" role="${selectionMessage.type === "error" ? "alert" : "status"}><p>${escapeHtml(selectionMessage.text)}</p>${messageDetailHtml(selectionMessage)}</div>`
      : "";
    const raceRows = newcomerRaces.length > 0
      ? `<div class="race-choice-list">${newcomerRaces.map((race) => {
        const key = window.ShinbaNewcomer.getRaceKey(race);
        const checked = selected.has(key);
        return `<label class="race-choice${checked ? " is-selected" : ""}">
          <input class="race-choice-input" type="checkbox" data-race-key="${escapeHtml(key)}"${checked ? " checked" : ""}>
          <span class="race-choice-main">
            <span class="race-choice-name">${escapeHtml(race.raceName)}</span>
            ${race.raceLabel ? `<span class="race-choice-label">${escapeHtml(race.raceLabel)}</span>` : ""}
          </span>
          <time class="race-choice-time">${escapeHtml(race.raceTime)}</time>
        </label>`;
      }).join("")}</div>`
      : `<p class="selection-empty">この日の新馬戦は見つかりませんでした。</p>`;

    app.innerHTML = `
      <header class="selection-heading">
        <h2>対象レース選択</h2>
        <p class="selection-date">${escapeHtml(dateText)}</p>
      </header>
      <div class="selection-toolbar">
        <div class="selection-tools">
          <button id="select-all-races-button" class="button button-secondary button-small" type="button"${newcomerRaces.length === 0 ? " disabled" : ""}>すべて選択</button>
          <button id="clear-all-races-button" class="button button-secondary button-small" type="button"${selectedRaceKeys.length === 0 ? " disabled" : ""}>すべて解除</button>
        </div>
        <span class="selection-count" aria-live="polite">${selectedRaces.length}レース選択中（全${newcomerRaces.length}レース）</span>
      </div>
      ${raceRows}
      ${message}
      <nav class="selection-footer" aria-label="レース選択操作">
        <button id="back-to-home-button" class="button button-secondary" type="button">一覧取得へ戻る</button>
        <button id="continue-selected-races-button" class="button button-primary" type="button">選択したレースで進む</button>
      </nav>`;

    app.querySelectorAll(".race-choice-input").forEach((input) => {
      input.addEventListener("change", () => {
        const key = input.dataset.raceKey;
        if (input.checked && !selectedRaceKeys.includes(key)) selectedRaceKeys.push(key);
        if (!input.checked) selectedRaceKeys = selectedRaceKeys.filter((item) => item !== key);
        selectionMessage = null;
        updateSelectedRaces();
        save();
        renderRaceSelection();
      });
    });
    document.getElementById("select-all-races-button").addEventListener("click", () => {
      selectedRaceKeys = newcomerRaces.map(window.ShinbaNewcomer.getRaceKey);
      selectionMessage = null;
      updateSelectedRaces();
      save();
      renderRaceSelection();
    });
    document.getElementById("clear-all-races-button").addEventListener("click", () => {
      selectedRaceKeys = [];
      selectionMessage = null;
      updateSelectedRaces();
      save();
      renderRaceSelection();
    });
    document.getElementById("back-to-home-button").addEventListener("click", () => {
      view = "home";
      selectionMessage = null;
      save();
      renderHome();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    document.getElementById("continue-selected-races-button").addEventListener("click", startSelectedRacesFlow);
  }

  function openPythonista() {
    if (isPythonistaLaunching || awaitingPythonistaResult) return;
    isPythonistaLaunching = true;
    awaitingPythonistaResult = true;
    pythonistaReturnNoticeShown = false;
    processedResultFingerprint = "";
    batchImportMessage = {
      type: "info",
      text: "Pythonistaで出馬表を取得します。完了後、自動的にSafariへ戻ります。"
    };
    save();
    renderRaceBatch();
    try {
      window.location.assign(pythonistaRunUrl());
    } catch (error) {
      isPythonistaLaunching = false;
      awaitingPythonistaResult = false;
      batchImportMessage = createUiError("Pythonistaとの連携を開始できませんでした。", error);
      save();
      renderRaceBatch();
    }
  }

  async function copyRequestAndOpenPythonista(request) {
    if (isPythonistaLaunching) return;
    isPythonistaLaunching = true;
    activeBatchRequest = withReturnContext(request);
    batchResultDraft = "";
    awaitingPythonistaResult = false;
    batchImportMessage = { type: "info", text: "Pythonista起動用データを準備しています…" };
    view = "raceBatch";
    save();
    renderRaceBatch();
    window.scrollTo({ top: 0, behavior: "smooth" });

    const requestJson = JSON.stringify(activeBatchRequest, null, 2);
    const requestTextarea = document.getElementById("batch-request-json");
    try {
      await copyText(requestJson, requestTextarea);
      isPythonistaLaunching = false;
      openPythonista();
    } catch (error) {
      isPythonistaLaunching = false;
      awaitingPythonistaResult = false;
      batchImportMessage = createUiError(
        "Pythonistaとの連携に失敗しました。トラブル時の操作から再試行してください。",
        error
      );
      save();
      renderRaceBatch();
    }
  }

  async function startSelectedRacesFlow() {
    updateSelectedRaces();
    if (selectedRaces.length === 0) {
      selectionMessage = { type: "error", text: "掲載するレースを1つ以上選択してください。" };
      save();
      renderRaceSelection();
      return;
    }

    let request;
    try {
      request = window.ShinbaBatch.buildPythonistaRequest(newcomerDate, selectedRaces);
    } catch (error) {
      selectionMessage = createUiError("選択したレースの準備に失敗しました。", error);
      save();
      renderRaceSelection();
      return;
    }

    clearBatchAutomationState();
    selectionMessage = null;
    activeBatchRequest = request;
    view = "raceBatch";
    save();
    await copyRequestAndOpenPythonista(request);
  }

  function applyCollectedRaces() {
    if (batchCollectedSources.length === 0) {
      batchImportMessage = { type: "error", text: "評価画面へ進める成功レースがありません。" };
      renderRaceBatch();
      return;
    }
    try {
      const sources = [...batchCollectedSources]
        .sort((a, b) => String(a.raceTime).localeCompare(String(b.raceTime)));
      const imported = sources.map((source) => window.ShinbaImport.importRaceData(source));
      races.splice(0, races.length, ...imported);
      importedRaceSources = sources;
      storyMeta.date = newcomerDate || storyMeta.date;
      activeHistoryDate = storyMeta.date;
      activeHistoryRecord = null;
      isHistoricalSession = false;
      currentIndex = 0;
      clearBatchAutomationState();
      view = "input";
      save();
      renderInput();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      batchImportMessage = createUiError("取得済みレースを評価画面へ反映できませんでした。", error);
      renderRaceBatch();
    }
  }

  function processPythonistaResultText(text) {
    const trimmed = String(text || "").trim();
    const payload = window.ShinbaBatch.validatePythonistaResultPayload(trimmed);
    const fingerprint = fingerprintText(trimmed);
    if (fingerprint === processedResultFingerprint) {
      const error = new Error("このPythonista結果はすでに読み込み済みです。");
      error.type = "DUPLICATE_PYTHONISTA_RESULT";
      throw error;
    }

    const request = getActiveBatchRequest();
    const result = window.ShinbaBatch.importBatchResult(payload, request);
    processedResultFingerprint = fingerprint;
    awaitingPythonistaResult = false;
    pythonistaReturnNoticeShown = true;
    mergeCollectedSources(result.sources);
    refreshCombinedProgress(result.progress);
    const missingRaces = getMissingSelectedRaces();

    if (missingRaces.length === 0 && batchCollectedSources.length === selectedRaces.length) {
      applyCollectedRaces();
      return;
    }

    const successCount = batchCollectedSources.length;
    batchImportMessage = {
      type: "error",
      text: `${successCount}レース取得成功 / ${missingRaces.length}レース取得失敗`,
      errors: batchPendingErrors
    };
    save();
    renderRaceBatch();
  }

  async function readPythonistaResultFromClipboard() {
    if (isBatchImporting) return;
    isBatchImporting = true;
    batchImportMessage = { type: "info", text: "Pythonistaの取得結果を読み込んでいます…" };
    renderRaceBatch();
    try {
      const clipboardText = await readClipboardText();
      const envelope = parsePythonistaResultEnvelope(clipboardText);
      assertExpectedPythonistaAction(envelope.action, PYTHONISTA_ACTIONS.selectedRaces);
      batchResultDraft = clipboardText;
      isBatchImporting = false;
      processPythonistaResultText(clipboardText);
    } catch (error) {
      isBatchImporting = false;
      batchImportMessage = createUiError(
        "Pythonistaの取得結果を読み込めませんでした。もう一度試すか、トラブル時の入力欄を使用してください。",
        error
      );
      save();
      renderRaceBatch();
      return;
    }
  }

  function retryMissingRaces() {
    const missingRaces = getMissingSelectedRaces();
    if (missingRaces.length === 0) {
      applyCollectedRaces();
      return;
    }
    let request;
    try {
      request = window.ShinbaBatch.buildPythonistaRequest(newcomerDate, missingRaces);
    } catch (error) {
      batchImportMessage = createUiError("失敗レースの再取得を開始できませんでした。", error);
      renderRaceBatch();
      return;
    }
    copyRequestAndOpenPythonista(request);
  }

  function renderRaceBatch() {
    document.body.classList.remove("story-mode");
    updateSelectedRaces();
    if (!newcomerDate || selectedRaces.length === 0) {
      view = "raceSelection";
      selectionMessage = { type: "error", text: "出馬表を取得するレースを1つ以上選択してください。" };
      save();
      renderRaceSelection();
      return;
    }

    let fullRequest;
    let request;
    try {
      fullRequest = window.ShinbaBatch.buildPythonistaRequest(newcomerDate, selectedRaces);
      request = getActiveBatchRequest();
    } catch (error) {
      view = "raceSelection";
      selectionMessage = createUiError("保存したレース選択を確認できませんでした。", error);
      save();
      renderRaceSelection();
      return;
    }

    const progressByKey = new Map(batchProgress.map((item) => [raceSourceKey(item), item]));
    const collectedKeys = new Set(batchCollectedSources.map(raceSourceKey));
    const activeKeys = new Set(request.selectedRaces.map(raceSourceKey));
    const progressRows = fullRequest.selectedRaces.map((race, index) => {
      const key = raceSourceKey(race);
      const progress = progressByKey.get(key);
      const status = collectedKeys.has(key)
        ? "success"
        : awaitingPythonistaResult && activeKeys.has(key)
          ? "processing"
          : progress && progress.status || "waiting";
      const statusText = status === "success" ? "取得済み" : status === "error" ? "エラー" : status === "processing" ? "確認中" : "取得待ち";
      return `<li class="batch-progress-item is-${status}">
        <span class="batch-progress-order">${index + 1} / ${fullRequest.selectedRaces.length}</span>
        <span class="batch-progress-race">${escapeHtml(race.raceName)}</span>
        <span class="batch-progress-status">${statusText}</span>
      </li>`;
    }).join("");
    const errorList = batchImportMessage && Array.isArray(batchImportMessage.errors) && batchImportMessage.errors.length > 0
      ? `<details class="error-detail"><summary>失敗内容を確認</summary><ul class="batch-error-list">${batchImportMessage.errors.map((error) => `<li><strong>${escapeHtml(error.raceName || "対象レース")}</strong><br><code>${escapeHtml(error.type)}</code> ${escapeHtml(error.message)}</li>`).join("")}</ul></details>`
      : "";
    const effectiveMessage = batchImportMessage || (awaitingPythonistaResult ? {
      type: "info",
      text: "Pythonistaの取得完了を待っています。Safariへ戻ったら結果読込ボタンを押してください。"
    } : null);
    const message = effectiveMessage
      ? `<div class="batch-message is-${effectiveMessage.type}" role="${effectiveMessage.type === "error" ? "alert" : "status"}"><p>${escapeHtml(effectiveMessage.text)}</p>${messageDetailHtml(effectiveMessage)}${errorList}</div>`
      : "";
    const requestJson = JSON.stringify(request, null, 2);
    const missingRaces = getMissingSelectedRaces();
    const hasPartialResult = Boolean(processedResultFingerprint) && missingRaces.length > 0;
    const controlsDisabled = isBatchImporting || isPythonistaLaunching;
    const partialActions = hasPartialResult
      ? `<section class="batch-panel" aria-labelledby="batch-partial-title">
          <h3 id="batch-partial-title">部分取得結果</h3>
          <p class="batch-description">成功した${batchCollectedSources.length}レースは保持されています。成功分だけで評価へ進むか、失敗レースだけを再取得できます。</p>
          <div class="batch-partial-actions">
            <button id="continue-successful-races-button" class="button button-secondary button-small" type="button"${batchCollectedSources.length === 0 || controlsDisabled ? " disabled" : ""}>成功分だけで評価へ進む</button>
            <button id="retry-failed-races-button" class="button button-primary button-small" type="button"${controlsDisabled ? " disabled" : ""}>失敗レースを再取得</button>
          </div>
        </section>`
      : "";

    app.innerHTML = `
      <header class="selection-heading">
        <h2>出馬表一括取得</h2>
        <p class="selection-date">${escapeHtml(window.ShinbaStory.formatStoryDate(newcomerDate))}</p>
      </header>
      <section class="batch-panel" aria-labelledby="batch-progress-title">
        <h3 id="batch-progress-title">対象レース</h3>
        <ul class="batch-progress-list" aria-live="polite">${progressRows}</ul>
      </section>
      <section class="batch-panel batch-automation-panel" aria-labelledby="batch-automation-title">
        <h3 id="batch-automation-title">Pythonista連携</h3>
        <p class="batch-description">Safariへ戻ったら、下のボタンを1回押して取得結果を読み込みます。</p>
        <div class="batch-automation-actions">
          <button id="read-pythonista-result-button" class="button button-primary" type="button"${controlsDisabled ? " disabled" : ""}>${isBatchImporting ? "読み込んでいます…" : "Pythonistaの取得結果を読み込む"}</button>
        </div>
      </section>
      <details class="trouble-panel"${batchImportMessage && batchImportMessage.type === "error" ? " open" : ""}>
        <summary>詳細 / トラブル時</summary>
        <div class="trouble-panel-body">
          <section class="batch-fallback-section" aria-labelledby="batch-request-title">
            <h3 id="batch-request-title">Pythonista入力データ</h3>
            <p class="batch-description">自動起動できない場合のみ、このデータをコピーしてPythonistaを開きます。</p>
            <textarea id="batch-request-json" class="json-input batch-json-output" readonly aria-label="Pythonista入力JSON">${escapeHtml(requestJson)}</textarea>
            <div class="import-actions">
              <button id="copy-and-open-pythonista-button" class="button button-primary button-small" type="button"${controlsDisabled ? " disabled" : ""}>コピーしてPythonistaを再起動</button>
              <button id="open-pythonista-button" class="button button-secondary button-small" type="button"${controlsDisabled ? " disabled" : ""}>コピー済みでPythonistaを開く</button>
            </div>
          </section>
          <section class="batch-fallback-section" aria-labelledby="batch-result-title">
            <h3 id="batch-result-title">Pythonista取得結果</h3>
            <p class="batch-description">クリップボードを直接読めない場合のみ、完成JSONを貼り付けます。</p>
            <textarea id="batch-result-json" class="json-input" aria-label="Pythonista取得結果JSON" placeholder='{"success":true,"date":"2026-08-08","races":[...]}'${isBatchImporting ? " disabled" : ""}>${escapeHtml(batchResultDraft)}</textarea>
            <div class="import-actions"><button id="import-batch-result-button" class="button button-secondary button-small" type="button"${controlsDisabled ? " disabled" : ""}>貼り付けた結果を読み込む</button></div>
          </section>
        </div>
      </details>
      ${message}
      ${partialActions}
      <nav class="batch-footer" aria-label="出馬表一括取得操作">
        <button id="back-to-race-selection-button" class="button button-secondary" type="button"${controlsDisabled ? " disabled" : ""}>レース選択へ戻る</button>
      </nav>`;

    const resultTextarea = document.getElementById("batch-result-json");
    resultTextarea.addEventListener("input", () => { batchResultDraft = resultTextarea.value; });
    document.getElementById("read-pythonista-result-button").addEventListener("click", readPythonistaResultFromClipboard);
    document.getElementById("copy-and-open-pythonista-button").addEventListener("click", () => copyRequestAndOpenPythonista(request));
    document.getElementById("open-pythonista-button").addEventListener("click", openPythonista);
    document.getElementById("import-batch-result-button").addEventListener("click", () => {
      batchResultDraft = resultTextarea.value;
      if (!batchResultDraft.trim()) {
        batchImportMessage = { type: "error", text: "Pythonistaの取得結果JSONを貼り付けてください。" };
        renderRaceBatch();
        return;
      }
      try {
        processPythonistaResultText(batchResultDraft);
      } catch (error) {
        batchImportMessage = createUiError("貼り付けた取得結果を読み込めませんでした。", error);
        save();
        renderRaceBatch();
      }
    });
    document.getElementById("continue-successful-races-button")?.addEventListener("click", applyCollectedRaces);
    document.getElementById("retry-failed-races-button")?.addEventListener("click", retryMissingRaces);
    document.getElementById("back-to-race-selection-button").addEventListener("click", () => {
      clearBatchAutomationState();
      view = "raceSelection";
      save();
      renderRaceSelection();
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
  }

  function requestAdvance() {
    const race = races[currentIndex];
    const action = currentIndex === races.length - 1 ? showSummary : () => {
      currentIndex += 1;
      save();
      renderInput();
      window.scrollTo({ top: 0, behavior: "smooth" });
    };

    if (window.ShinbaValidation.isAllZero(race.rating, RATING_FIELDS)) {
      pendingAction = action;
      dialog.hidden = false;
      document.body.style.overflow = "hidden";
      dialogCancel.focus();
      return;
    }
    action();
  }

  function closeDialog() {
    dialog.hidden = true;
    document.body.style.overflow = "";
    document.getElementById("next-button")?.focus();
  }

  function openResetDialog() {
    const date = workingDate();
    document.getElementById("reset-dialog-title").textContent = `${historyDateLabel(date)}をリセットしますか？`;
    document.getElementById("reset-dialog-message").textContent = `${historyDateLabel(date)}の一覧、選択、評価、Pythonista連携状態、メモ、Story一時状態だけを削除します。他の日付の履歴は残ります。`;
    resetDialog.hidden = false;
    document.body.style.overflow = "hidden";
    resetDialogCancel.focus();
  }

  function closeResetDialog() {
    resetDialog.hidden = true;
    document.body.style.overflow = "";
    resetDataButton.focus();
  }

  function showSummary() {
    view = "summary";
    save();
    renderSummary();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function openMemoSync() {
    memoSyncMessage = null;
    const record = await flushHistorySave();
    if (!record) {
      memoSyncMessage = { type: "error", text: "同期対象の履歴を保存できませんでした。" };
    } else {
      activeHistoryRecord = record;
    }
    view = "memoSync";
    save();
    renderMemoSync();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function memoSyncRows(record) {
    if (!record) return [];
    return record.races.flatMap((race) => race.horses.map((horse) => ({ race, horse })));
  }

  function renderMemoSync() {
    document.body.classList.remove("story-mode");
    const record = activeHistoryRecord;
    const rows = memoSyncRows(record);
    const eligible = rows.filter(({ horse }) => /^\d{10}$/.test(String(horse.horseId || "")));
    const syncedCount = eligible.filter(({ horse }) => horse.netkeibaMemoSync && horse.netkeibaMemoSync.status === "synced").length;
    const status = memoSyncMessage
      ? `<div class="home-status is-${memoSyncMessage.type}" role="${memoSyncMessage.type === "error" ? "alert" : "status"}"><p>${escapeHtml(memoSyncMessage.text)}</p>${messageDetailHtml(memoSyncMessage)}</div>`
      : "";
    app.innerHTML = `
      <header class="selection-heading"><h2>netkeiba馬メモへ同期</h2><p class="selection-date">${escapeHtml(record ? historyDateLabel(record.date) : "履歴未保存")}</p></header>
      <section class="memo-sync-panel">
        <p class="home-description">既存メモは残し、新馬戦チャレンジのブロックを追記します。同一日付・raceIdのブロックは重複登録しません。</p>
        <p class="memo-sync-count">同期済み ${syncedCount} / 対象 ${eligible.length}頭</p>
        <ul class="memo-preview-list">${rows.map(({ race, horse }) => {
          const available = /^\d{10}$/.test(String(horse.horseId || ""));
          const sync = horse.netkeibaMemoSync || { status: "not_synced" };
          const label = !available ? "horseIdなし" : sync.status === "synced" ? "同期済み" : sync.status === "error" ? "前回失敗" : "未同期";
          const preview = available ? window.ShinbaMemoSync.buildMemoText(race, horse, record.date, appSettings.memoTemplate, window.ShinbaRating.toStars) : "";
          return `<li class="memo-preview-item is-${escapeHtml(sync.status || "not_synced")}">
            <div class="memo-preview-heading"><strong>${escapeHtml(race.raceName)} ${escapeHtml(horse.mark)} ${escapeHtml(horse.number)} ${escapeHtml(horse.name)}</strong><span>${escapeHtml(label)}</span></div>
            ${available ? `<pre>${escapeHtml(preview)}</pre>` : ""}
          </li>`;
        }).join("")}</ul>
        ${status}
        <div class="summary-footer-actions">
          <button id="memo-sync-back-button" class="button button-secondary" type="button"${isMemoSyncBusy ? " disabled" : ""}>確認へ戻る</button>
          ${awaitingMemoSync
            ? `<button id="memo-sync-read-button" class="button button-primary" type="button"${isMemoSyncBusy ? " disabled" : ""}>${isMemoSyncBusy ? "読み込んでいます…" : "同期結果を読み込む"}</button>`
            : `<button id="memo-sync-start-button" class="button button-primary" type="button"${!record || eligible.length === 0 || isMemoSyncBusy ? " disabled" : ""}>内容を確認して同期</button>`}
        </div>
      </section>`;
    document.getElementById("memo-sync-back-button").addEventListener("click", () => { view = "summary"; save(); renderSummary(); });
    document.getElementById("memo-sync-start-button")?.addEventListener("click", startMemoSync);
    document.getElementById("memo-sync-read-button")?.addEventListener("click", readMemoSyncResult);
  }

  async function startMemoSync() {
    if (isMemoSyncBusy || awaitingMemoSync || !activeHistoryRecord) return;
    isMemoSyncBusy = true;
    try {
      memoSyncRequest = window.ShinbaMemoSync.buildRequest(
        activeHistoryRecord,
        appSettings,
        window.ShinbaConfig.getCurrentReturnUrl(),
        window.ShinbaRating.toStars
      );
      await copyText(JSON.stringify(memoSyncRequest));
      awaitingMemoSync = true;
      memoSyncMessage = { type: "info", text: "Pythonistaで馬メモを同期しています…" };
      save();
      window.location.assign(pythonistaRunUrl());
    } catch (error) {
      memoSyncMessage = createUiError("馬メモ同期を開始できませんでした。", error);
    } finally {
      isMemoSyncBusy = false;
      renderMemoSync();
    }
  }

  async function applyMemoSyncResult(resultInput) {
    if (!activeHistoryRecord) {
      const missing = new Error("馬メモ同期結果を反映する履歴がありません。");
      missing.type = "MEMO_CONTEXT_MISSING";
      throw missing;
    }
    const result = window.ShinbaMemoSync.validateResult(resultInput);
    const updated = window.ShinbaMemoSync.applyResult(activeHistoryRecord, result);
    activeHistoryRecord = await window.ShinbaHistoryStore.putHistory(updated);
    const working = window.ShinbaHistoryModel.toWorkingState(activeHistoryRecord);
    importedRaceSources = working.sources;
    races.forEach((race, index) => {
      race.betPlan = working.sources[index] && working.sources[index].betPlan || null;
      race.marks.forEach((mark) => {
        const sourceHorse = working.sources[index] && working.sources[index].horses.find((horse) => horse.number === mark.number);
        if (sourceHorse) mark.netkeibaMemoSync = sourceHorse.netkeibaMemoSync;
      });
    });
    awaitingMemoSync = false;
    memoSyncRequest = null;
    const failures = result.items.filter((item) => item.status !== "synced").length;
    memoSyncMessage = failures
      ? { type: "error", text: `${result.items.length - failures}頭同期成功 / ${failures}頭失敗。成功分は保存しました。` }
      : { type: "success", text: `${result.items.length}頭の馬メモを同期しました。` };
    await refreshHistoryRecords();
    save();
  }

  async function readMemoSyncResult() {
    if (isMemoSyncBusy || !activeHistoryRecord) return;
    isMemoSyncBusy = true;
    memoSyncMessage = { type: "info", text: "同期結果を読み込んでいます…" };
    renderMemoSync();
    try {
      const clipboardText = await readClipboardText();
      const envelope = parsePythonistaResultEnvelope(clipboardText);
      assertExpectedPythonistaAction(envelope.action, PYTHONISTA_ACTIONS.horseMemos);
      await applyMemoSyncResult(envelope.payload);
    } catch (error) {
      memoSyncMessage = createUiError("馬メモ同期結果を読み込めませんでした。", error);
    } finally {
      isMemoSyncBusy = false;
      renderMemoSync();
    }
  }

  async function openBetPlan() {
    const record = await flushHistorySave();
    if (record) activeHistoryRecord = record;
    betPlanRaceIndex = Math.max(0, Math.min(races.length - 1, betPlanRaceIndex));
    betPlanMessage = null;
    betConfirmationOpen = false;
    view = "betPlan";
    save();
    renderBetPlan();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setCurrentBetPlan(plan) {
    const race = races[betPlanRaceIndex];
    const sourceIndex = importedRaceSources.findIndex((source) => raceSourceKey(source) === raceSourceKey(race));
    if (sourceIndex < 0) throw new Error("買い目の保存先レースを確認できませんでした。");
    races[betPlanRaceIndex].betPlan = plan;
    importedRaceSources[sourceIndex] = { ...importedRaceSources[sourceIndex], betPlan: plan };
    save();
  }

  function currentBetPlan() {
    const race = races[betPlanRaceIndex];
    const source = importedRaceSources.find((item) => raceSourceKey(item) === raceSourceKey(race));
    return window.ShinbaBetPlan.normalize(source && source.betPlan || window.ShinbaBetPlan.create(race.raceId), race.raceId);
  }

  function renderBetPlan() {
    document.body.classList.remove("story-mode");
    const race = races[betPlanRaceIndex];
    if (!race) { view = "summary"; renderSummary(); return; }
    const plan = currentBetPlan();
    const dayPlans = importedRaceSources.map((source) => source.betPlan).filter(Boolean);
    const dayTotal = dayPlans.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);
    const message = betPlanMessage ? `<div class="home-status is-${betPlanMessage.type}"><p>${escapeHtml(betPlanMessage.text)}</p>${messageDetailHtml(betPlanMessage)}</div>` : "";
    const confirmation = betConfirmationOpen ? `<section class="purchase-confirmation" aria-labelledby="purchase-confirm-title">
      <h3 id="purchase-confirm-title">最終購入確認</h3>
      <p><strong>${escapeHtml(race.raceName)}</strong> / ${escapeHtml(window.ShinbaBetPlan.PROVIDERS.find((item) => item.id === plan.provider)?.label || "投票先未選択")} / 合計 ${plan.totalAmount.toLocaleString("ja-JP")}円</p>
      <ul>${plan.bets.map((bet) => `<li>${escapeHtml(bet.type)} ${escapeHtml(bet.numbers.join("-"))}　${bet.amount.toLocaleString("ja-JP")}円</li>`).join("")}</ul>
      <label class="settings-check"><input id="purchase-human-confirm" type="checkbox"> 内容・金額を人間が確認しました</label>
      <p class="safety-note">この版は確認済み状態を保存するだけで、即PAT/UMACAへの購入送信は行いません。</p>
      <button id="confirm-bet-plan-button" class="button button-primary" type="button">確認済みとして保存</button>
    </section>` : "";
    app.innerHTML = `
      <header class="selection-heading"><h2>買い目を確認</h2><p class="selection-date">${escapeHtml(historyDateLabel(workingDate()))}</p></header>
      <nav class="bet-race-tabs">${races.map((item, index) => `<button class="button button-small ${index === betPlanRaceIndex ? "button-primary" : "button-secondary"}" data-bet-race-index="${index}" type="button">${escapeHtml(item.raceName)}</button>`).join("")}</nav>
      <section class="bet-plan-panel">
        <div class="form-field"><label for="bet-provider">投票先</label><select id="bet-provider" class="form-input"><option value="">選択してください</option>${window.ShinbaBetPlan.PROVIDERS.map((provider) => `<option value="${provider.id}"${plan.provider === provider.id ? " selected" : ""}>${escapeHtml(provider.label)}</option>`).join("")}</select></div>
        <form id="add-bet-form" class="bet-entry-grid">
          <div class="form-field"><label for="bet-type">式別</label><select id="bet-type" class="form-input">${window.ShinbaBetPlan.BET_TYPES.map((type) => `<option>${escapeHtml(type)}</option>`).join("")}</select></div>
          <div class="form-field"><label for="bet-numbers">馬番</label><input id="bet-numbers" class="form-input" inputmode="numeric" placeholder="例：6 または 6,8"></div>
          <div class="form-field"><label for="bet-amount">金額</label><input id="bet-amount" class="form-input" type="number" min="100" step="100" value="100"></div>
          <button class="button button-secondary" type="submit">買い目を追加</button>
        </form>
        <ul class="bet-list">${plan.bets.length ? plan.bets.map((bet, index) => `<li><span>${escapeHtml(bet.type)} ${escapeHtml(bet.numbers.join("-"))}</span><strong>${bet.amount.toLocaleString("ja-JP")}円</strong><button class="button button-secondary button-small remove-bet-button" data-bet-index="${index}" type="button">削除</button></li>`).join("") : "<li class=\"history-empty\">買い目はまだありません。</li>"}</ul>
        <div class="bet-totals"><span>このレース ${plan.totalAmount.toLocaleString("ja-JP")} / ${appSettings.maxPerRace.toLocaleString("ja-JP")}円</span><span>本日 ${dayTotal.toLocaleString("ja-JP")} / ${appSettings.maxPerDay.toLocaleString("ja-JP")}円</span></div>
        ${message}${confirmation}
        <div class="summary-footer-actions"><button id="bet-plan-back-button" class="button button-secondary" type="button">確認へ戻る</button><button id="open-bet-confirmation-button" class="button button-primary" type="button">購入内容を最終確認</button></div>
      </section>`;
    app.querySelectorAll("[data-bet-race-index]").forEach((button) => button.addEventListener("click", () => { betPlanRaceIndex = Number(button.dataset.betRaceIndex); betConfirmationOpen = false; betPlanMessage = null; save(); renderBetPlan(); }));
    document.getElementById("bet-provider").addEventListener("change", (event) => { try { setCurrentBetPlan({ ...plan, provider: event.target.value || null, status: "draft", confirmedAt: null }); betPlanMessage = null; } catch (error) { betPlanMessage = createUiError("投票先を保存できませんでした。", error); } renderBetPlan(); });
    document.getElementById("add-bet-form").addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        const candidate = window.ShinbaBetPlan.normalize({ ...plan, provider: document.getElementById("bet-provider").value || null, status: "draft", confirmedAt: null, bets: [...plan.bets, { type: document.getElementById("bet-type").value, numbers: document.getElementById("bet-numbers").value, amount: Number(document.getElementById("bet-amount").value) }] }, race.raceId);
        setCurrentBetPlan(candidate); betPlanMessage = { type: "success", text: "買い目を保存しました。" }; betConfirmationOpen = false;
      } catch (error) { betPlanMessage = createUiError("買い目を追加できませんでした。", error); }
      renderBetPlan();
    });
    app.querySelectorAll(".remove-bet-button").forEach((button) => button.addEventListener("click", () => { const bets = plan.bets.filter((item, index) => index !== Number(button.dataset.betIndex)); setCurrentBetPlan(window.ShinbaBetPlan.normalize({ ...plan, bets, status: "draft", confirmedAt: null }, race.raceId)); betConfirmationOpen = false; renderBetPlan(); }));
    document.getElementById("open-bet-confirmation-button").addEventListener("click", () => { betConfirmationOpen = true; betPlanMessage = null; renderBetPlan(); });
    document.getElementById("confirm-bet-plan-button")?.addEventListener("click", () => {
      if (!document.getElementById("purchase-human-confirm").checked) { betPlanMessage = { type: "error", text: "購入内容を確認したチェックを入れてください。" }; renderBetPlan(); return; }
      try {
        const candidatePlans = importedRaceSources.map((source) => raceSourceKey(source) === raceSourceKey(race) ? plan : source.betPlan).filter(Boolean);
        const confirmed = window.ShinbaBetPlan.confirm(plan, candidatePlans, appSettings);
        setCurrentBetPlan(confirmed); betConfirmationOpen = false; betPlanMessage = { type: "success", text: "確認済みとして保存しました。購入処理は実行していません。" };
      } catch (error) { betPlanMessage = createUiError("買い目を確認済みにできませんでした。", error); }
      renderBetPlan();
    });
    document.getElementById("bet-plan-back-button").addEventListener("click", () => { view = "summary"; save(); renderSummary(); });
  }

  function renderSummary() {
    document.body.classList.remove("story-mode");
    app.innerHTML = `
      <p class="summary-intro">全${races.length}レースの予想と評価を確認してください。</p>
      <section class="summary-list" aria-label="全レース確認">
        ${races.map((race, index) => `
          <article class="summary-card">
            <header class="race-heading"><h2>${escapeHtml(race.raceName)}</h2><span class="race-time">発走 ${escapeHtml(race.raceTime)}</span></header>
            <div class="summary-body">
              <ul class="marks-list" aria-label="予想印">${marksHtml(race)}</ul>
              <div class="summary-ratings">
                ${RATING_FIELDS.map((field) => `<div class="summary-rating"><span>${field.label}</span><span class="summary-stars" aria-label="${race.rating[field.key]}点">${window.ShinbaRating.toStars(race.rating[field.key])}</span></div>`).join("")}
              </div>
              <div class="summary-actions"><button class="button button-secondary button-small edit-button" type="button" data-race-index="${index}">修正</button></div>
            </div>
          </article>`).join("")}
      </section>
      <section class="story-meta-editor" aria-labelledby="story-meta-title">
        <h2 id="story-meta-title">Storyヘッダー</h2>
        <p class="story-meta-note">日付と任意メモは入力と同時に自動保存されます。</p>
        <div class="story-meta-fields">
          <div class="form-field">
            <label for="story-date-input">日付</label>
            <input id="story-date-input" class="form-input" type="date" value="${escapeHtml(storyMeta.date)}">
          </div>
          <div class="form-field">
            <label for="story-memo-input">任意メモ</label>
            <input id="story-memo-input" class="form-input" type="text" maxlength="40" value="${escapeHtml(storyMeta.memo)}" placeholder="例：今週の注目新馬戦">
          </div>
        </div>
      </section>
      <div class="summary-footer-actions">
        <button id="summary-home-button" class="button button-secondary" type="button">ホームへ戻る</button>
        <button id="open-memo-sync-button" class="button button-secondary" type="button">netkeibaメモへ同期</button>
        <button id="open-bet-plan-button" class="button button-secondary" type="button">買い目を確認</button>
        <button id="show-story-button" class="button button-primary" type="button">ストーリーを表示</button>
      </div>`;

    app.querySelectorAll(".edit-button").forEach((button) => {
      button.addEventListener("click", () => {
        currentIndex = Number(button.dataset.raceIndex);
        view = "input";
        save();
        renderInput();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
    document.getElementById("story-date-input").addEventListener("input", (event) => {
      flushHistorySave();
      storyMeta.date = event.target.value || todayIso();
      activeHistoryDate = storyMeta.date;
      activeHistoryRecord = null;
      isHistoricalSession = storyMeta.date !== todayIso();
      save();
    });
    document.getElementById("story-memo-input").addEventListener("input", (event) => {
      storyMeta.memo = event.target.value.slice(0, 40);
      save();
    });
    document.getElementById("summary-home-button").addEventListener("click", returnHome);
    document.getElementById("open-memo-sync-button").addEventListener("click", openMemoSync);
    document.getElementById("open-bet-plan-button").addEventListener("click", openBetPlan);
    document.getElementById("show-story-button").addEventListener("click", startStoryRendering);
  }

  async function startStoryRendering() {
    if (isStoryRendering) return;
    isStoryRendering = true;
    const button = document.getElementById("show-story-button");
    if (button) {
      button.disabled = true;
      button.textContent = "Storyを生成しています…";
    }
    try {
      await flushHistorySave();
      showStory();
    } catch (error) {
      console.error("Storyの生成に失敗しました。", error);
      isStoryRendering = false;
      if (button) {
        button.disabled = false;
        button.textContent = "ストーリーを表示";
      }
    }
  }

  function showStory() {
    view = "story";
    save();
    document.body.classList.add("story-mode");
    window.ShinbaStory.mount(app, races, {
      title: "新馬戦チャレンジ",
      date: storyMeta.date,
      memo: storyMeta.memo,
      displayMarks: DISPLAY_MARKS,
      ratingFields: RATING_FIELDS,
      toStars: window.ShinbaRating.toStars,
      perfectRatingRainbow: appSettings.perfectRatingRainbow,
      onBack: () => {
        view = "summary";
        save();
        renderSummary();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
    isStoryRendering = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  dialogCancel.addEventListener("click", () => { pendingAction = null; closeDialog(); });
  dialogConfirm.addEventListener("click", () => {
    const action = pendingAction;
    pendingAction = null;
    closeDialog();
    if (action) action();
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) { pendingAction = null; closeDialog(); } });
  resetDataButton.addEventListener("click", openResetDialog);
  resetDialogCancel.addEventListener("click", closeResetDialog);
  resetDialogConfirm.addEventListener("click", resetDayData);
  resetDialog.addEventListener("click", (event) => { if (event.target === resetDialog) closeResetDialog(); });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!resetDialog.hidden) {
      closeResetDialog();
      return;
    }
    if (!dialog.hidden) {
      pendingAction = null;
      closeDialog();
    }
  });

  function handlePotentialPythonistaReturn() {
    if (document.visibilityState === "hidden") return;
    if (view === "memoSync" && awaitingMemoSync) {
      if (memoSyncMessage && memoSyncMessage.type === "info" && memoSyncMessage.text.includes("戻りました")) return;
      memoSyncMessage = { type: "info", text: "Pythonistaから戻りました。「同期結果を読み込む」を押してください。" };
      save();
      renderMemoSync();
      return;
    }
    if (view === "home" && awaitingNewcomerList) {
      if (newcomerReturnNoticeShown) return;
      isNewcomerLaunching = false;
      newcomerReturnNoticeShown = true;
      newcomerAutomationMessage = {
        type: "info",
        text: "Pythonistaから戻りました。「新馬戦一覧の取得結果を読み込む」を押してください。"
      };
      save();
      renderHome();
      return;
    }
    if (view !== "raceBatch" || !awaitingPythonistaResult) return;
    if (pythonistaReturnNoticeShown) return;
    isPythonistaLaunching = false;
    pythonistaReturnNoticeShown = true;
    batchImportMessage = {
      type: "info",
      text: "Pythonistaから戻りました。「Pythonistaの取得結果を読み込む」を押してください。"
    };
    renderRaceBatch();
  }

  document.addEventListener("visibilitychange", handlePotentialPythonistaReturn);
  window.addEventListener("pageshow", handlePotentialPythonistaReturn);
  window.addEventListener("focus", handlePotentialPythonistaReturn);

  function renderCurrentView() {
    if (view === "story") showStory();
    else if (view === "settings") renderSettings();
    else if (view === "memoSync") renderMemoSync();
    else if (view === "betPlan") renderBetPlan();
    else if (view === "summary") renderSummary();
    else if (view === "raceBatch") renderRaceBatch();
    else if (view === "raceSelection") renderRaceSelection();
    else if (view === "input") renderInput();
    else renderHome();
  }

  async function initialize() {
    const returnedFromPythonista = consumePythonistaReturnSignal();
    restore();
    if (returnedFromPythonista && awaitingNewcomerList) {
      view = "home";
      awaitingGenericPythonistaResult = false;
      isNewcomerLaunching = false;
      newcomerReturnNoticeShown = true;
      newcomerAutomationMessage = {
        type: "info",
        text: "Pythonistaから戻りました。「新馬戦一覧の取得結果を読み込む」を押してください。"
      };
    } else if (returnedFromPythonista && awaitingPythonistaResult) {
      view = "raceBatch";
      isPythonistaLaunching = false;
      batchImportMessage = {
        type: "info",
        text: "Pythonistaから戻りました。「Pythonistaの取得結果を読み込む」を押してください。"
      };
      pythonistaReturnNoticeShown = true;
    } else if (returnedFromPythonista && awaitingMemoSync) {
      view = "memoSync";
      memoSyncMessage = { type: "info", text: "Pythonistaから戻りました。「同期結果を読み込む」を押してください。" };
    } else if (returnedFromPythonista) {
      view = "home";
      awaitingNewcomerList = true;
      awaitingGenericPythonistaResult = true;
      isNewcomerLaunching = false;
      newcomerReturnNoticeShown = true;
      newcomerAutomationMessage = {
        type: "info",
        text: "Pythonistaから戻りました。「Pythonistaの取得結果を読み込む」を押してください。"
      };
    }

    try {
      await window.ShinbaHistoryStore.openDatabase();
      await window.ShinbaHistoryStore.migrateLegacyStorage(STORAGE_KEY);
      await window.ShinbaHistoryStore.migrateHistorySchema();
      historyReady = true;
      if (hasHistoryContent()) await persistActiveHistory();
      await refreshHistoryRecords();
    } catch (error) {
      historyReady = false;
      historyMessage = createUiError(
        "日付別履歴を利用できません。現在日の入力は引き続き保存されます。",
        error
      );
    }

    save();
    renderCurrentView();
    if (returnedFromPythonista) void tryAutomaticPythonistaResultRead();
  }

  function updateNetworkStatus() {
    if (!networkStatus) return;
    networkStatus.hidden = navigator.onLine;
  }

  window.addEventListener("online", updateNetworkStatus);
  window.addEventListener("offline", updateNetworkStatus);
  updateNetworkStatus();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch((error) => {
      console.warn("Service Workerを登録できませんでした。", error);
    }));
  }

  app.innerHTML = `<section class="home-start" aria-busy="true"><p class="home-description">保存データを確認しています…</p></section>`;
  initialize();
}());
