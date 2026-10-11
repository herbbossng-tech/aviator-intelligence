# Live observation: pre-work review checklist

**Status: not started. Nothing in this repository connects to a live game, betting site or account.**

No live-observation code may be written until every question below has a documented answer and the project owner has explicitly approved the approach. Real-money execution and betting automation stay out of scope regardless of the outcome.

## 1. Platform terms and permission

- Which operator(s) and which game provider are involved? (Aviator is developed by Spribe and offered through many operators. Each may have different terms.)
- What do the operator's terms of use say about automated access, scraping, data collection and reuse of game data?
- What do the game provider's terms say?
- Is there an official, documented API or data feed for round results? Who may use it, and under what licence?
- Is written permission needed? Has it been obtained?
- Are there jurisdictional rules (for example, gambling regulation where the user lives) that affect collecting or using this data?

## 2. Authorised data-access method

- Does the method work **without** logging in to a betting account? If it needs an account, it is out of scope.
- Does it work without reading cookies, session tokens or browser storage? If not, it is out of scope.
- Does it avoid bypassing CAPTCHAs, rate limits or anti-bot controls? If not, it is out of scope.
- Does it avoid undocumented or private endpoints? If not, it is out of scope.
- Is the data source's own provenance clear enough to record as a `source` value?

## 3. Technical feasibility

- Latency, availability and rate limits of the permitted source.
- Can each round be uniquely identified (`source_round_id`) to prevent duplicates?
- Does the source provide trustworthy event timestamps (`event_at`), or only our observation time (`observed_at`)?
- How are gaps, outages and corrections detected and recorded?

## 4. Security and privacy

- What, if anything, must be stored? It must never include passwords, tokens, cookies or storage state.
- Network exposure: the API stays on loopback, and any outbound connection is documented.
- Logging must not capture personal or account data.
- Threat model for any third-party library or browser tooling introduced.

## 5. Product honesty

- The UI must show when live data is actually connected, and it must never show a fake live indicator.
- Live data must feed the same "historical description" pipeline. It must never be presented as a prediction signal.

## Decision record

| Date       | Question(s) | Finding | Decision | Approved by |
| ---------- | ----------- | ------- | -------- | ----------- |
| _none yet_ |             |         |          |             |
