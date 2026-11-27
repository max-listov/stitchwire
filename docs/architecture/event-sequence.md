---
title: SDK event sequence state machine
description: Constant-space cross-frame validation without subscriber recovery policy.
type: architecture
status: active
created: 2026-08-30
updated: 2026-09-04 15:46 +07:00
---

One subscription observes one declared producer/topic. State is a subscription identity, producer,
current boot, optional named successor and next sequence: constant space, not a producer map.
Neither payloads nor timestamps determine continuity. Sequence checks supplement frame schemas.

| Input/state | Accepted transition | Action |
| --- | --- | --- |
| Fresh feed | First event or gap anchors current boot/sequence | Bind subscription and producer |
| Resume cursor | Current boot; expected sequence is afterSeq+1 | Retain cursor floor |
| Event | Exact expected sequence, or first anchor | Advance expected by one |
| Ordinary range gap | fromSeq equals expected; toSeq is not before fromSeq | Advance to toSeq+1 |
| Resume gap wholly below expected | A behind/empty lane says it cannot prove the cursor | Preserve expected; never rewind |
| Named boot-change gap | Distinct explicit nextBootId; no pending successor | Remember successor, preserve current floor |
| Old-boot tail after marker | Continues exact current sequence | Advance current floor |
| First named-successor frame | Switch only to the named boot | Re-anchor; successor may already be mid-epoch |
| Empty successor followed by its marker | Switch to named boot, then name its successor | No fabricated event or missing range |
| Explicit error | Valid identity/classification | Yield typed terminal and release resources |
| EOF | No further frames | Finish; does not prove durable receipt or complete history |
| Local abort/close | Caller stops consumption | Cancel/release; no retry or resubscription |

The old range in a boot-change marker is broker high-water, not this subscriber's delivered
position. It must not advance the local floor. A changed topic/producer/subscription, duplicate
event, skipped event without a gap, unnamed boot or inconsistent marker raises
`WireClientError` with `invalid-response`. State is discarded when the feed ends.

The broker sends a boot-change marker only together with the first accepted event of the new boot,
from the last boot it announced to that boot. A boot whose events are all refused for the topic rate
is not announced, so a chain of refused boots reaches subscribers as one marker.

The topic rate (`maxEventsPerSecond`) belongs to the topic, not to a boot. Above it the topic allows one
boot opening a second: the first event of a boot none of whose events was accepted yet. A producer
that restarts inside the second its old boot used up is admitted at once, and a producer that starts a
boot for every event gets at most one event a second above the rate.

An initial refusal may have no subscription identity because no subscription was admitted.
After admission, identities remain exact. Required failure/refusal/retry fields are never filled
in by the SDK. Unknown additive response fields are ignored, not promoted into authority.

Owner journals, retention decisions and domain cursors remain with services. Applications decide
whether to reconnect, recover a gap or display an incomplete view. The SDK adds validation, not
a recovery loop. Regression proof is in `test/client-event-sequence.test.ts`,
`test/client-outcomes.test.ts` and the packed Bun/Node composition and sequence fixtures.
