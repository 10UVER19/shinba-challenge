(function () {
  "use strict";

  const MIN = 0;
  const MAX = 5;

  function clamp(value) {
    return Math.max(MIN, Math.min(MAX, Math.round(Number(value) || 0)));
  }

  function toStars(value) {
    const safeValue = clamp(value);
    return "★".repeat(safeValue) + "☆".repeat(MAX - safeValue);
  }

  function valueFromPointer(container, clientX) {
    const rect = container.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    if (x <= 2) return 0;
    return clamp(Math.ceil((x / rect.width) * MAX));
  }

  function updateVisual(container, value) {
    const safeValue = clamp(value);
    container.dataset.value = String(safeValue);
    container.setAttribute("aria-valuenow", String(safeValue));
    container.setAttribute("aria-valuetext", toStars(safeValue));
    container.querySelectorAll(".star").forEach((star, index) => {
      star.classList.toggle("is-filled", index < safeValue);
      star.textContent = index < safeValue ? "★" : "☆";
    });
  }

  function bind(container, initialValue, onChange) {
    let dragging = false;
    let pointerId = null;

    const commit = (value) => {
      const safeValue = clamp(value);
      updateVisual(container, safeValue);
      onChange(safeValue);
    };

    updateVisual(container, initialValue);

    container.addEventListener("pointerdown", (event) => {
      dragging = true;
      pointerId = event.pointerId;
      container.classList.add("is-dragging");
      container.setPointerCapture(pointerId);
      commit(valueFromPointer(container, event.clientX));
      event.preventDefault();
    });

    container.addEventListener("pointermove", (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      commit(valueFromPointer(container, event.clientX));
      event.preventDefault();
    });

    const finish = (event) => {
      if (!dragging || event.pointerId !== pointerId) return;
      dragging = false;
      container.classList.remove("is-dragging");
      if (container.hasPointerCapture(pointerId)) container.releasePointerCapture(pointerId);
      pointerId = null;
    };

    container.addEventListener("pointerup", finish);
    container.addEventListener("pointercancel", finish);

    container.addEventListener("keydown", (event) => {
      const current = Number(container.dataset.value);
      if (["ArrowRight", "ArrowUp"].includes(event.key)) commit(current + 1);
      else if (["ArrowLeft", "ArrowDown"].includes(event.key)) commit(current - 1);
      else if (event.key === "Home" || event.key === "0") commit(0);
      else if (event.key === "End") commit(MAX);
      else return;
      event.preventDefault();
    });
  }

  window.ShinbaRating = { MIN, MAX, clamp, toStars, bind };
}());
