(function () {
  "use strict";

  const PNG_CONFIG = {
    width: 1080,
    height: 1920,
    backgroundColor: "#FFFFFF",
    mimeType: "image/png",
    filePrefix: "shinba_challenge"
  };

  class PngExportError extends Error {
    constructor(type, message, cause) {
      super(message);
      this.name = "PngExportError";
      this.type = type;
      this.cause = cause || null;
    }
  }

  async function waitForFonts() {
    if (!document.fonts || !document.fonts.ready) return;
    try {
      await document.fonts.ready;
    } catch (error) {
      console.warn("フォント読み込み完了を確認できませんでした。", error);
    }
  }

  function createExportClone(sourceElement) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    Object.assign(host.style, {
      position: "fixed",
      top: "0",
      left: "-12000px",
      width: `${PNG_CONFIG.width}px`,
      height: `${PNG_CONFIG.height}px`,
      overflow: "hidden",
      pointerEvents: "none",
      background: PNG_CONFIG.backgroundColor
    });

    const clone = sourceElement.cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.add("story-export-canvas");
    clone.setAttribute("aria-hidden", "true");
    clone.style.setProperty("position", "relative", "important");
    clone.style.setProperty("inset", "auto", "important");
    clone.style.setProperty("top", "0", "important");
    clone.style.setProperty("left", "0", "important");
    clone.style.setProperty("width", `${PNG_CONFIG.width}px`, "important");
    clone.style.setProperty("height", `${PNG_CONFIG.height}px`, "important");
    clone.style.setProperty("transform", "none", "important");
    clone.style.setProperty("transform-origin", "top left", "important");
    clone.style.setProperty("background", PNG_CONFIG.backgroundColor, "important");
    host.appendChild(clone);
    document.body.appendChild(host);
    return { host, clone };
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new PngExportError("PNG_BLOB_FAILED", "PNGデータを作成できませんでした。"));
      }, PNG_CONFIG.mimeType);
    });
  }

  async function renderStoryElement(sourceElement) {
    if (!sourceElement) {
      throw new PngExportError("STORY_CANVAS_NOT_FOUND", "Storyキャンバスが見つかりません。");
    }
    if (typeof window.html2canvas !== "function") {
      throw new PngExportError("HTML2CANVAS_UNAVAILABLE", "PNG生成ライブラリを読み込めませんでした。");
    }

    await waitForFonts();
    const { host, clone } = createExportClone(sourceElement);
    try {
      const canvas = await window.html2canvas(clone, {
        backgroundColor: PNG_CONFIG.backgroundColor,
        scale: 1,
        width: PNG_CONFIG.width,
        height: PNG_CONFIG.height,
        windowWidth: PNG_CONFIG.width,
        windowHeight: PNG_CONFIG.height,
        scrollX: 0,
        scrollY: 0,
        useCORS: true,
        allowTaint: false,
        logging: false,
        removeContainer: true
      });
      if (canvas.width !== PNG_CONFIG.width || canvas.height !== PNG_CONFIG.height) {
        throw new PngExportError(
          "PNG_SIZE_MISMATCH",
          `PNGサイズが${PNG_CONFIG.width}×${PNG_CONFIG.height}ではありません。`
        );
      }
      return canvasToBlob(canvas);
    } catch (error) {
      if (error instanceof PngExportError) throw error;
      throw new PngExportError("PNG_RENDER_FAILED", "PNGの生成に失敗しました。", error);
    } finally {
      host.remove();
    }
  }

  function createPngAsset(blob, date, pageIndex) {
    const safeDate = String(date || "date").replace(/[^0-9-]/g, "-");
    const page = String(Number(pageIndex) + 1).padStart(2, "0");
    const name = `${PNG_CONFIG.filePrefix}_${safeDate}_${page}.png`;
    const file = typeof File === "function"
      ? new File([blob], name, { type: PNG_CONFIG.mimeType })
      : null;
    return { blob, file, name };
  }

  function canShareAssets(assets) {
    if (!navigator.canShare || typeof navigator.share !== "function") return false;
    const files = assets.map((asset) => asset.file);
    if (files.some((file) => !file)) return false;
    try {
      return navigator.canShare({ files });
    } catch (error) {
      return false;
    }
  }

  function shareAssets(assets) {
    if (!canShareAssets(assets)) {
      throw new PngExportError("WEB_SHARE_UNAVAILABLE", "この環境ではPNGファイル共有を利用できません。");
    }
    return navigator.share({
      files: assets.map((asset) => asset.file),
      title: "新馬戦チャレンジ"
    });
  }

  function createDownloadItems(assets) {
    return assets.map((asset) => ({
      name: asset.name,
      url: URL.createObjectURL(asset.blob)
    }));
  }

  function revokeDownloadItems(items) {
    items.forEach((item) => URL.revokeObjectURL(item.url));
  }

  function downloadAssets(assets) {
    const items = createDownloadItems(assets);
    items.forEach((item, index) => {
      window.setTimeout(() => {
        const link = document.createElement("a");
        link.href = item.url;
        link.download = item.name;
        link.rel = "noopener";
        document.body.appendChild(link);
        link.click();
        link.remove();
      }, index * 180);
    });
    return items;
  }

  window.ShinbaPng = {
    PNG_CONFIG,
    PngExportError,
    renderStoryElement,
    createPngAsset,
    canShareAssets,
    shareAssets,
    createDownloadItems,
    revokeDownloadItems,
    downloadAssets
  };
}());
