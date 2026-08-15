(function () {
  "use strict";

  function validateRaceMarks(race, supportedMarks) {
    const errors = [];
    const marks = Array.isArray(race && race.marks) ? race.marks : [];
    const allowed = new Set(supportedMarks || []);
    const validMarks = marks.filter((entry) => entry && allowed.has(entry.mark));
    const mainMarkCount = validMarks.filter((entry) => entry.mark === "◎").length;

    if (mainMarkCount > 1) errors.push("◎は1頭だけ指定できます。");
    if (validMarks.length === 0) errors.push("少なくとも1頭に印を指定してください。");

    return { isValid: errors.length === 0, errors };
  }

  function isAllZero(rating, fields) {
    return fields.every((field) => Number(rating[field.key]) === 0);
  }

  window.ShinbaValidation = { validateRaceMarks, isAllZero };
}());
