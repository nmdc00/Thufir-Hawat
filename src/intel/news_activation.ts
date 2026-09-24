/** Source-grounded context for a single stored breaking-news item. */
export interface NewsActivation {
  id: string;
  intelId: string;
  source: string;
  text: string;
  receivedAtMs: number;
  publishedAtMs?: number;
  matchedKeyword?: string;
}
