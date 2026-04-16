import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildSearchMatcher,
  DEFAULT_SEARCH_OPTIONS,
  type SearchMatcher,
  type SearchOptions,
} from "./session-inspector.helpers";

export function useSearchController() {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);

  const { matcher, isRegexInvalid } = useMemo(() => {
    const result = buildSearchMatcher(query, options);
    if (result === null) {
      if (options.useRegex && query.trim().length > 0) {
        return { matcher: null, isRegexInvalid: true };
      }
      return { matcher: null, isRegexInvalid: false };
    }
    return { matcher: result, isRegexInvalid: false };
  }, [query, options]);

  useEffect(() => {
    setCurrentMatchIndex(0);
  }, [query, options]);

  const goToNext = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentMatchIndex((prev) => (prev + 1) % matchCount);
  }, [matchCount]);

  const goToPrevious = useCallback(() => {
    if (matchCount === 0) return;
    setCurrentMatchIndex((prev) => (prev - 1 + matchCount) % matchCount);
  }, [matchCount]);

  const handleOptionsChange = useCallback((next: SearchOptions) => {
    setOptions(next);
  }, []);

  return {
    currentMatchIndex,
    isRegexInvalid,
    matcher: matcher as SearchMatcher | null,
    matchCount,
    onOptionsChange: handleOptionsChange,
    onQueryChange: setQuery,
    onNext: goToNext,
    onPrevious: goToPrevious,
    options,
    query,
    setMatchCount,
  };
}
