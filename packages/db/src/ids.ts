import { monotonicFactory } from "ulid";

const factory = monotonicFactory();

/**
 * Generate a ULID that is STRICTLY MONOTONIC within this process, even for
 * multiple ids in the same millisecond. Audit timelines are ordered by id, so
 * this guarantee is load-bearing — do not swap for plain `ulid()`.
 */
export function newUlid(): string {
  return factory();
}
