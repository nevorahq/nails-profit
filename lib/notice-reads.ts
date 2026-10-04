/**
 * The bell's answer with the reads made on this screen laid over it.
 *
 * Opening a line reads it locally at once and writes it behind, and a list
 * asked for before that write landed can answer after it. Taken as it came,
 * that answer put the line back unread and the dot back on until the next
 * poll — thirty seconds of the bell saying the opposite of what was just done.
 *
 * `readHere` maps an appointment to the moment of the event that was read. A
 * line stays read while its event is no newer than that; a newer event on the
 * same appointment is past the mark and comes back unread, which is the
 * server's own rule (`staff_notice_read`).
 */

type FeedRow = Readonly<{ booking_id: string; happened_at: string; unread: boolean }>;

type WithFeed<Row extends FeedRow> = Readonly<{ feed: readonly Row[]; unread: number }>;

export function withLocalReads<Row extends FeedRow, Answer extends WithFeed<Row>>(
  answer: Answer,
  readHere: ReadonlyMap<string, string>,
): Answer {
  if (readHere.size === 0) return answer;
  const feed = answer.feed.map((row) =>
    row.unread && isCoveredBy(row, readHere.get(row.booking_id)) ? { ...row, unread: false } : row,
  );
  return { ...answer, feed, unread: feed.filter((row) => row.unread).length };
}

/**
 * The marks an answer has made unnecessary: the server already says read, or
 * something newer has happened since. Kept apart from `withLocalReads` so that
 * one stays pure — it runs inside a state updater, which React may call twice.
 */
export function settledReads(
  answer: WithFeed<FeedRow>,
  readHere: ReadonlyMap<string, string>,
): string[] {
  return answer.feed
    .filter((row) => readHere.has(row.booking_id))
    .filter((row) => !row.unread || !isCoveredBy(row, readHere.get(row.booking_id)))
    .map((row) => row.booking_id);
}

function isCoveredBy(row: FeedRow, readAt: string | undefined) {
  return readAt !== undefined && Date.parse(row.happened_at) <= Date.parse(readAt);
}
