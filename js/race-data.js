(function () {
  "use strict";

  const ALL_MARKS = ["◎", "○", "▲", "△", "☆", "注", "✓"];
  const DISPLAY_MARKS = ["◎", "○", "▲"];
  const RATING_FIELDS = [
    { key: "expectation", label: "期待度" },
    { key: "fieldLevel", label: "出走馬レベル" },
    { key: "value", label: "配当妙味" }
  ];

  const races = [
    {
      id: "niigata-5r",
      raceName: "新潟5R",
      raceTime: "12:25",
      marks: [
        { mark: "◎", number: 4, horseName: "グランオギュール" },
        { mark: "○", number: 6, horseName: "マハロハ" },
        { mark: "▲", number: 9, horseName: "ヴェルバーニア" }
      ],
      rating: { expectation: 0, fieldLevel: 0, value: 0 }
    },
    {
      id: "niigata-6r",
      raceName: "新潟6R",
      raceTime: "12:55",
      marks: [
        { mark: "◎", number: 2, horseName: "トランサルピナ" },
        { mark: "○", number: 16, horseName: "アルニタク" },
        { mark: "▲", number: 7, horseName: "ミラクルオーラ" }
      ],
      rating: { expectation: 0, fieldLevel: 0, value: 0 }
    },
    {
      id: "chukyo-5r",
      raceName: "中京5R",
      raceTime: "12:15",
      marks: [
        { mark: "◎", number: 2, horseName: "ツーハーツ" },
        { mark: "○", number: 6, horseName: "レイクイーン" },
        { mark: "▲", number: 7, horseName: "ユーダブルワン" }
      ],
      rating: { expectation: 0, fieldLevel: 0, value: 0 }
    }
  ];

  window.ShinbaData = {
    ALL_MARKS,
    DISPLAY_MARKS,
    RATING_FIELDS,
    races: races.slice().sort((a, b) => a.raceTime.localeCompare(b.raceTime))
  };
}());
