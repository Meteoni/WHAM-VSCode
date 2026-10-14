/**
 * A count in the room a badge or a card footer has for it: in full with the
 * locale's thousands separator under ten thousand (999, 1,000, 9,999), then in
 * K and M with one decimal (10K, 10.1K, 999.9K, 1.2M, 100.1M).
 *
 * Floored throughout, so a number never reads above itself: 99999 is "99.9K",
 * not the "100K" that says a hundred thousand. The full number belongs in the
 * element's title or tooltip beside it.
 */
export function formatCompactCount(count: number): string {
  if (count < 10000) {
    return count.toLocaleString();
  }
  if (count < 1000000) {
    return `${Math.floor(count / 100) / 10}K`;
  }
  return `${Math.floor(count / 100000) / 10}M`;
}
