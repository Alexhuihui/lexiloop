import { describe, expect, it } from "vitest";
import { groupQuickRecallCards, type QuickRecallCard } from "./QuickRecall";

describe("quick-recall visible card grouping", () => {
  it("merges consecutive meaning cards for one word without merging other card types", () => {
    const cards: QuickRecallCard[] = [
      {
        form: "word",
        wordKey: "work",
        headword: "work",
        phonetic: "/wɜːk/",
        answer: { senses: [{ pos: "v", gloss: "工作；运转" }] },
      },
      {
        form: "word",
        wordKey: "work",
        headword: "work",
        phonetic: "/wɜːk/",
        answer: { senses: [{ pos: "n", gloss: "工作成果；作品" }] },
      },
      {
        form: "word",
        wordKey: "world",
        headword: "world",
        phonetic: "/wɜːld/",
        answer: { senses: [{ pos: "n", gloss: "世界" }] },
      },
      {
        form: "phrase",
        wordKey: "work",
        text: "at work",
        answer: { phraseGloss: "在工作" },
      },
    ];

    const groups = groupQuickRecallCards(cards);
    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({ rawStart: 0, rawLength: 2 });
    expect(groups[0]?.card.answer?.senses).toEqual([
      { pos: "v", gloss: "工作；运转" },
      { pos: "n", gloss: "工作成果；作品" },
    ]);
    expect(groups[1]).toMatchObject({ rawStart: 2, rawLength: 1 });
    expect(groups[2]).toMatchObject({ rawStart: 3, rawLength: 1 });
  });
});
