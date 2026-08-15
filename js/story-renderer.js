(function () {
  "use strict";

  const STORY_CONFIG = {
    width: 1080,
    height: 1920,
    racesPerPage: 6,
    background: "#FFFFFF",
    mainColor: "rgb(9,52,148)",
    borderColor: "#D4AF37",
    displayMarks: ["◎", "○", "▲"],
    perfectRatingRainbow: true
  };

  const CIRCLED_NUMBERS = ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱"];

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;"
    }[character]));
  }

  function sortByRaceTime(races) {
    return races.slice().sort((a, b) => a.raceTime.localeCompare(b.raceTime));
  }

  function paginateRaces(races, pageSize) {
    const size = Math.max(1, Number(pageSize) || STORY_CONFIG.racesPerPage);
    const pages = [];
    const sorted = sortByRaceTime(races);
    for (let index = 0; index < sorted.length; index += size) {
      pages.push(sorted.slice(index, index + size));
    }
    return pages;
  }

  function toCircledNumber(number) {
    const value = Number(number);
    return CIRCLED_NUMBERS[value] || String(number);
  }

  function visibleMarks(race, displayMarks) {
    return displayMarks.flatMap((mark) => race.marks.filter((entry) => entry.mark === mark));
  }

  function getHorseNameSize(name) {
    const length = Array.from(String(name)).length;
    if (length >= 12) return 24;
    if (length >= 10) return 27;
    if (length >= 8) return 29;
    if (length >= 7) return 31;
    return 33;
  }

  function formatStoryDate(dateValue) {
    const parts = String(dateValue || "").split("-").map(Number);
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) return escapeHtml(dateValue || "");
    const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    const weekday = weekdays[new Date(parts[0], parts[1] - 1, parts[2]).getDay()];
    const month = String(parts[1]).padStart(2, "0");
    const day = String(parts[2]).padStart(2, "0");
    return `${parts[0]}.${month}.${day}(${weekday})`;
  }

  function renderRatingStars(value, toStars, perfectRatingRainbow) {
    const numericValue = Number(value);
    if (numericValue === 5 && perfectRatingRainbow) {
      const stars = Array.from({ length: 5 }, () => '<span class="story-perfect-star">★</span>').join("");
      return `<span class="story-rating-stars is-perfect" aria-label="5点">${stars}</span>`;
    }
    return `<span class="story-rating-stars" aria-label="${escapeHtml(numericValue)}点">${escapeHtml(toStars(numericValue))}</span>`;
  }

  function renderCard(race, options) {
    const picks = visibleMarks(race, options.displayMarks).map((entry) => `
      <li class="story-pick" data-mark="${escapeHtml(entry.mark)}">
        <span class="story-pick-mark">${escapeHtml(entry.mark)}</span>
        <span class="story-pick-number">${escapeHtml(toCircledNumber(entry.number))}</span>
        <span class="story-pick-name" style="font-size:${getHorseNameSize(entry.horseName)}px">${escapeHtml(entry.horseName)}</span>
      </li>`).join("");

    const ratings = options.ratingFields.map((field) => `
      <div class="story-rating-row">
        <span>${escapeHtml(field.label)}</span>
        ${renderRatingStars(race.rating[field.key], options.toStars, options.perfectRatingRainbow)}
      </div>`).join("");

    return `<article class="story-race-card">
      <header class="story-card-header">${escapeHtml(race.raceName)}</header>
      <ul class="story-picks">${picks}</ul>
      <div class="story-rating-list">${ratings}</div>
    </article>`;
  }

  function renderCanvas(canvas, pageRaces, options) {
    const memo = String(options.memo || "").trim();
    canvas.innerHTML = `
      <h1 class="story-title">${escapeHtml(options.title || "新馬戦チャレンジ")}</h1>
      <div class="story-meta-line">
        <p class="story-date">${formatStoryDate(options.date)}</p>
        ${memo ? `<p class="story-memo">メモ：${escapeHtml(memo)}</p>` : ""}
      </div>
      <section class="story-card-grid" aria-label="レース予想">
        ${pageRaces.map((race) => renderCard(race, options)).join("")}
      </section>
      <footer class="story-footer">※馬券は自己責任</footer>`;
  }

  function fitCanvas(viewport, frame, canvas) {
    const availableWidth = viewport.clientWidth;
    const availableHeight = Math.max(320, window.innerHeight - viewport.getBoundingClientRect().top - 24);
    const scale = Math.min(1, availableWidth / STORY_CONFIG.width, availableHeight / STORY_CONFIG.height);
    canvas.style.transform = `scale(${scale})`;
    frame.style.width = `${STORY_CONFIG.width * scale}px`;
    frame.style.height = `${STORY_CONFIG.height * scale}px`;
  }

  function mount(root, races, options) {
    const pages = paginateRaces(races);
    const renderOptions = { perfectRatingRainbow: STORY_CONFIG.perfectRatingRainbow, ...options };
    let currentPage = 0;
    let isExporting = false;
    let preparedAssets = [];
    let downloadItems = [];
    let shareReady = false;

    root.innerHTML = `<section class="story-view">
      <nav class="story-controls" aria-label="ストーリー確認操作">
        <button id="story-back-button" class="button button-secondary" type="button">編集へ戻る</button>
        <div class="story-control-group">
          <button id="story-png-save-button" class="button button-primary" type="button">PNG保存</button>
          <div class="story-pagination"${pages.length < 2 ? " hidden" : ""}>
            <button id="story-previous-page" class="button button-secondary story-page-button" type="button" aria-label="前のページ">前へ</button>
            <span id="story-page-label" class="story-page-label"></span>
            <button id="story-next-page" class="button button-secondary story-page-button" type="button" aria-label="次のページ">次へ</button>
          </div>
        </div>
      </nav>
      <p id="story-export-status" class="story-export-status" role="status" hidden></p>
      <div id="story-download-list" class="story-download-list" hidden></div>
      <div class="story-viewport">
        <div class="story-scale-frame">
          <div id="story-canvas" class="story-canvas" role="img" aria-label="Instagram Story完成レイアウト"></div>
        </div>
      </div>
    </section>`;

    const viewport = root.querySelector(".story-viewport");
    const frame = root.querySelector(".story-scale-frame");
    const canvas = root.querySelector("#story-canvas");
    const label = root.querySelector("#story-page-label");
    const previous = root.querySelector("#story-previous-page");
    const next = root.querySelector("#story-next-page");
    const back = root.querySelector("#story-back-button");
    const pngButton = root.querySelector("#story-png-save-button");
    const exportStatus = root.querySelector("#story-export-status");
    const downloadList = root.querySelector("#story-download-list");

    function syncControls() {
      back.disabled = isExporting;
      pngButton.disabled = isExporting;
      previous.disabled = isExporting || currentPage === 0;
      next.disabled = isExporting || currentPage === pages.length - 1;
    }

    function showPage(index) {
      currentPage = Math.max(0, Math.min(pages.length - 1, index));
      renderCanvas(canvas, pages[currentPage] || [], renderOptions);
      label.textContent = `${currentPage + 1} / ${pages.length}`;
      syncControls();
    }

    function setExporting(value) {
      isExporting = Boolean(value);
      syncControls();
    }

    function setExportStatus(message, type) {
      exportStatus.hidden = !message;
      exportStatus.textContent = message || "";
      exportStatus.className = `story-export-status${type ? ` is-${type}` : ""}`;
    }

    function clearDownloadItems() {
      if (downloadItems.length > 0) window.ShinbaPng.revokeDownloadItems(downloadItems);
      downloadItems = [];
      downloadList.hidden = true;
      downloadList.innerHTML = "";
    }

    function showDownloadItems(items) {
      clearDownloadItems();
      downloadItems = items;
      downloadList.innerHTML = items.map((item, index) => `
        <a class="button button-secondary button-small" href="${escapeHtml(item.url)}" download="${escapeHtml(item.name)}">PNG ${index + 1}をダウンロード</a>
      `).join("");
      downloadList.hidden = items.length === 0;
    }

    function waitForCanvasPaint() {
      return new Promise((resolve) => window.requestAnimationFrame(
        () => window.requestAnimationFrame(resolve)
      ));
    }

    function downloadPreparedAssets(message) {
      const items = window.ShinbaPng.downloadAssets(preparedAssets);
      showDownloadItems(items);
      shareReady = false;
      pngButton.textContent = "PNGを再生成";
      setExportStatus(message || `${preparedAssets.length}枚のPNGを保存しました。`, "success");
    }

    async function sharePreparedAssets() {
      if (preparedAssets.length === 0 || isExporting) return;
      setExporting(true);
      setExportStatus("iOS共有シートを開いています…", "info");
      try {
        await window.ShinbaPng.shareAssets(preparedAssets);
        shareReady = true;
        pngButton.textContent = "PNGを再共有";
        setExportStatus(`${preparedAssets.length}枚のPNGを共有しました。`, "success");
      } catch (error) {
        if (error && error.name === "AbortError") {
          shareReady = true;
          pngButton.textContent = "共有を再開";
          setExportStatus("共有をキャンセルしました。PNGは再共有できます。", "info");
        } else if (error && error.name === "NotAllowedError") {
          shareReady = true;
          pngButton.textContent = "共有して保存";
          setExportStatus("PNGを生成しました。「共有して保存」をもう一度押してください。", "info");
        } else {
          console.error("PNG共有に失敗しました。", error);
          downloadPreparedAssets("共有を利用できないためPNGダウンロードへ切り替えました。");
        }
      } finally {
        setExporting(false);
      }
    }

    async function generatePngPages() {
      if (isExporting) return;
      if (!window.ShinbaPng) {
        setExportStatus("PNGの生成に失敗しました。", "error");
        console.error("ShinbaPngが読み込まれていません。");
        return;
      }

      setExporting(true);
      clearDownloadItems();
      preparedAssets = [];
      shareReady = false;
      pngButton.textContent = "PNGを生成しています…";
      const originalPage = currentPage;

      try {
        for (let index = 0; index < pages.length; index += 1) {
          showPage(index);
          setExportStatus(`PNGを生成しています… ${index + 1} / ${pages.length}`, "info");
          await waitForCanvasPaint();
          const blob = await window.ShinbaPng.renderStoryElement(canvas);
          preparedAssets.push(window.ShinbaPng.createPngAsset(blob, options.date, index));
        }
        showPage(originalPage);
        setExporting(false);

        if (window.ShinbaPng.canShareAssets(preparedAssets)) {
          shareReady = true;
          pngButton.textContent = "共有して保存";
          await sharePreparedAssets();
        } else {
          downloadPreparedAssets();
        }
      } catch (error) {
        console.error("PNGの生成に失敗しました。", error);
        showPage(originalPage);
        preparedAssets = [];
        shareReady = false;
        pngButton.textContent = "PNG保存";
        setExportStatus("PNGの生成に失敗しました。再試行してください。", "error");
      } finally {
        setExporting(false);
      }
    }

    previous.addEventListener("click", () => showPage(currentPage - 1));
    next.addEventListener("click", () => showPage(currentPage + 1));
    pngButton.addEventListener("click", () => {
      if (shareReady && preparedAssets.length > 0) sharePreparedAssets();
      else generatePngPages();
    });
    back.addEventListener("click", () => {
      clearDownloadItems();
      options.onBack();
    });

    const resize = () => fitCanvas(viewport, frame, canvas);
    window.addEventListener("resize", resize);
    if (window.ResizeObserver) new ResizeObserver(resize).observe(viewport);

    showPage(0);
    resize();
  }

  window.ShinbaStory = { STORY_CONFIG, sortByRaceTime, paginateRaces, toCircledNumber, formatStoryDate, renderRatingStars, renderCanvas, mount };
}());
