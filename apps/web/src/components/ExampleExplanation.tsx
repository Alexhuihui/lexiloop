import type { WordContentResponse } from "../lib/api-client";

interface ExampleExplanationProps {
  exampleKey: string;
  origin: string;
  explanations: WordContentResponse["explanations"];
}

/** Keeps a real-exam sentence next to the teaching notes that explain it. */
export function ExampleExplanation({
  exampleKey,
  origin,
  explanations,
}: ExampleExplanationProps): React.JSX.Element | null {
  if (origin !== "exam") {
    return null;
  }
  const explanation =
    explanations.find((candidate) =>
      candidate.context_meanings.some((meaning) => meaning.example_key === exampleKey),
    ) ?? explanations[0];
  if (!explanation) {
    return null;
  }
  const contextualMeaning = explanation.context_meanings.find(
    (meaning) => meaning.example_key === exampleKey,
  );

  return (
    <aside className="example-explanation" aria-label="真题句子讲解">
      <strong className="example-explanation__title">句子讲解</strong>
      {contextualMeaning ? <p>语境义：{contextualMeaning.gloss}</p> : null}
      {explanation.syntax_notes.length > 0 ? (
        <p>句子结构：{explanation.syntax_notes.join("；")}</p>
      ) : null}
      <p>理解提示：{explanation.translation_hints}</p>
    </aside>
  );
}
