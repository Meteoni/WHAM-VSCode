import { useCallback, useEffect } from 'react';
import useSWR from 'swr';
import {
  type RequestResult,
  useGetModReviewVotes,
  useRetractModReviewVote,
  useVoteModReview,
} from '@app/webviewIPC';
import type { ModReviewVote } from '@app/webviewIPCMessages';

declare const WEBPACK_IS_WEBSITE: boolean;

export type VoteOutcome = 'written' | 'failed' | 'abandoned';

// What the cache holds for a mod: the host's list, or null where the read
// failed - a host over a core from before the command - which is no votes and
// no voting for the session.
type CachedVotes = ModReviewVote[] | null;

export type ModReviewVotesState = {
  // Undefined while the read is out.
  votes: CachedVotes | undefined;
  // Records an upvote, holding the cache at the vote while the host writes it
  // and putting it back if the host refuses.
  recordVote: (reviewId: number) => Promise<VoteOutcome>;
  // Takes an upvote back, the cache without it while the host writes and with
  // it again if the host refuses.
  retractVote: (reviewId: number) => Promise<VoteOutcome>;
};

// What a write answers: the mod's whole list after it, which replaces the
// cache, with the outcome flag and the error a refusal carries.
type VotesWriteReply = {
  votes: ModReviewVote[];
  succeeded: boolean;
  error?: unknown;
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

// Thrown inside the write to make SWR roll the optimistic list back; which
// exit it was is read off the outcome beside it.
class VoteNotWritten extends Error {}

function useModReviewVotesFromHost(modId: string | null): ModReviewVotesState {
  const { getModReviewVotes } = useGetModReviewVotes();
  const { voteModReview } = useVoteModReview();
  const { retractModReviewVote } = useRetractModReviewVote();

  // SWR as the cache and the subscription only: the read below is an effect
  // of its own rather than SWR's fetcher, because the hook it posts through
  // abandons its request on unmount, and the mount-unmount-mount of a strict
  // render would leave SWR deduping the second mount's read against the
  // abandoned first. An entry, once read, stands for the session; a write
  // puts the host's answer into it.
  const { data, mutate } = useSWR<CachedVotes>(
    modId === null ? null : ['modReviewVotes', modId],
    null
  );

  useEffect(() => {
    if (modId === null || data !== undefined) {
      return;
    }
    let current = true;
    void (async () => {
      const result = await getModReviewVotes({ modId });
      // A request the unmount abandoned leaves the entry as it was: the next
      // mount asks again.
      if (!current || result.status !== 'reply') {
        return;
      }
      await mutate(result.data.error ? null : result.data.votes, {
        revalidate: false,
      });
    })();
    return () => {
      current = false;
    };
  }, [modId, data, getModReviewVotes, mutate]);

  // A write to the host's list: the cache shows `optimistic` while the request
  // is out, then the host's list, or what it showed before if the host refused.
  const write = useCallback(
    async (
      send: () => Promise<RequestResult<VotesWriteReply>>,
      optimistic: (current: ModReviewVote[]) => ModReviewVote[]
    ): Promise<VoteOutcome> => {
      let outcome: VoteOutcome = 'written';
      try {
        await mutate(
          async () => {
            const result = await send();
            if (result.status !== 'reply') {
              outcome = 'abandoned';
              throw new VoteNotWritten();
            }
            if (!result.data.succeeded || result.data.error) {
              outcome = 'failed';
              throw new VoteNotWritten();
            }
            return result.data.votes;
          },
          {
            optimisticData: (current) => optimistic(current ?? []),
            rollbackOnError: true,
            populateCache: true,
            revalidate: false,
          }
        );
      } catch (error) {
        if (!(error instanceof VoteNotWritten)) {
          throw error;
        }
      }
      return outcome;
    },
    [mutate]
  );

  const recordVote = useCallback(
    (reviewId: number): Promise<VoteOutcome> => {
      if (modId === null) {
        return Promise.resolve('failed');
      }
      return write(
        () => voteModReview({ modId, reviewId }),
        (current) => [...current, { reviewId, timestamp: nowSeconds() }]
      );
    },
    [modId, write, voteModReview]
  );

  const retractVote = useCallback(
    (reviewId: number): Promise<VoteOutcome> => {
      if (modId === null) {
        return Promise.resolve('failed');
      }
      return write(
        () => retractModReviewVote({ modId, reviewId }),
        (current) => current.filter((vote) => vote.reviewId !== reviewId)
      );
    },
    [modId, write, retractModReviewVote]
  );

  return { votes: data, recordVote, retractVote };
}

// The website has no profile to hold a vote, so it draws the server's counts
// alone: nothing voted, nothing to record or take back.
const websiteVotes: ModReviewVotesState = {
  votes: [],
  recordVote: () => Promise.resolve('failed'),
  retractVote: () => Promise.resolve('failed'),
};

function useModReviewVotesOnWebsite(): ModReviewVotesState {
  return websiteVotes;
}

/**
 * The user's votes on a mod's reviews, read from the host once a key is
 * given and kept for the session, so a modal reopened on the mod draws the
 * marks at once.
 */
export const useModReviewVotes: (modId: string | null) => ModReviewVotesState =
  WEBPACK_IS_WEBSITE ? useModReviewVotesOnWebsite : useModReviewVotesFromHost;
