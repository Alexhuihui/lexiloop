/**
 * The /dictionary page (spec 9.5): one query box over the release's combined
 * search (exact headword > prefix headword > Chinese gloss > phrase >
 * example full text, ranked server-side). Every hit renders its matched
 * field's label and highlights the matched portion of the matched field
 * text, and links into the full word entry.
 */

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { ApiClient, SearchHit, SearchMatchedField } from "../../lib/api-client";

export interface SearchPageProps {
  api: ApiClient;
}

/** Visible label per matched field (spec 9.5 priority, top to bottom). */
const FIELD_LABELS: Readonly<Record<SearchMatchedField, string>> = {
  headword_exact: "精确词头",
  headword_prefix: "词头前缀",
  sense_gloss: "中文释义",
  phrase: "短语",
  example: "例句",
};

/**
 * The first case-insensitive occurrence of the query (or of its first
 * token, since the server's FTS match is token-based), as
 * [before, matched, after]; null when the text does not contain it.
 */
function findMatch(text: string, query: string): [string, string, string] | null {
  const lowerText = text.toLowerCase();
  const candidates = [query, query.match(/[\p{L}\p{N}]+/u)?.[0] ?? ""];
  for (const candidate of candidates) {
    if (candidate === "") {
      continue;
    }
    const index = lowerText.indexOf(candidate.toLowerCase());
    if (index >= 0) {
      return [
        text.slice(0, index),
        text.slice(index, index + candidate.length),
        text.slice(index + candidate.length),
      ];
    }
  }
  return null;
}

function HighlightedText({ text, query }: { text: string; query: string }): React.JSX.Element {
  const parts = findMatch(text, query);
  if (!parts) {
    return <>{text}</>;
  }
  const [before, matched, after] = parts;
  return (
    <>
      {before}
      <mark>{matched}</mark>
      {after}
    </>
  );
}

function HitItem({ hit, query }: { hit: SearchHit; query: string }): React.JSX.Element {
  const headwordIsMatch =
    hit.matched_field === "headword_exact" || hit.matched_field === "headword_prefix";
  return (
    <li>
      <p>
        <Link to={`/dictionary/words/${hit.word_key}`}>
          {headwordIsMatch ? (
            <HighlightedText text={hit.headword} query={query} />
          ) : (
            hit.headword
          )}
          {hit.phonetic ? ` ${hit.phonetic}` : null}
        </Link>
      </p>
      <p>
        <span>{FIELD_LABELS[hit.matched_field]}</span>
        {headwordIsMatch ? null : (
          <>
            {" "}
            <HighlightedText text={hit.matched_text} query={query} />
          </>
        )}
      </p>
    </li>
  );
}

export function SearchPage({ api }: SearchPageProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");

  const search = useQuery({
    queryKey: ["content", "search", query],
    queryFn: () => api.searchContent(query),
    enabled: query !== "",
  });

  return (
    <section>
      <h1>词典</h1>
      <form
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery(input.trim());
        }}
      >
        <label htmlFor="dict-search">搜索词或释义</label>
        <input
          id="dict-search"
          type="search"
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="submit" className="btn btn--primary">
          搜索
        </button>
      </form>

      {search.isPending && query === "" ? (
        <p>输入词头、中文释义、短语或例句进行搜索。</p>
      ) : null}
      {search.isPending && query !== "" ? <p role="status">正在搜索…</p> : null}
      {search.isError ? <p role="alert">搜索失败，请稍后重试。</p> : null}
      {search.data && search.data.hits.length === 0 ? (
        <p role="status">没有找到相关词条。</p>
      ) : null}
      {search.data && search.data.hits.length > 0 ? (
        <ul aria-label="搜索结果">
          {search.data.hits.map((hit) => (
            <HitItem key={`${hit.word_key}-${hit.matched_field}`} hit={hit} query={query} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
