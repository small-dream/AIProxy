# Insights Guide

Insights aggregates your captured sessions into statistics, so you can quickly see overall traffic health: which host has the most requests, the error rate, P95 latency, and which requests are slowest or largest.

## Data source

Insights data comes from the **captured Sessions** in the current workspace — no extra config:

- **While capturing**: the front end aggregates from the latest sessions in real time (~150 ms throttled refresh), so the numbers move with traffic
- **After capture stabilizes**: it switches to a backend-persisted aggregate (~5 s debounced), avoiding repeated computation

So Insights reflects exactly the requests you see in [Sessions](./sessions.md).

## Where to find it

1. Click **Insights** in the left nav

## Overview cards

The overview cards at the top give whole-traffic metrics:

| Metric | Meaning |
|---|---|
| Total requests | Number of captured requests |
| Error rate | Share of 4xx / 5xx requests |
| Avg duration | Average response time across all requests |
| P95 duration | 95th-percentile response time (a truer long-tail feel) |
| Total traffic | Total request / response bytes |

## By-host table

The core is a per-host stats table:

| Column | Meaning |
|---|---|
| Host | Hostname |
| Requests | Request count |
| Errors | Error count (status ≥ 400) |
| Avg Duration | Average duration |
| P95 Duration | That host's P95 duration |
| Traffic | Traffic size |

- **Click a row**: jump to Sessions filtered by that host to see the details
- **Right-click a row**: set that host as an exact filter, add to exclusions, copy, or view all its requests

## Distributions & rankings

- **Status-code distribution**: horizontal bars, descending by count
- **Method distribution**: horizontal bars, descending by GET / POST / … count
- **Request ranking**: toggle between "Slowest requests" and "Largest requests"; rows carry color-intensity markers for status, size, and duration
  - Default shows **Top 20** (with no host filter)
  - When filtered to a host, all matching requests for that host are shown

The list uses virtual scrolling, so even many requests browse smoothly.

## Host filter

Filter hosts at the top:

- **Keyword**: host contains the text
- **Exact match**: host equals the value
- **Exclude**: host does not equal the value

Active filters appear as chips and can be cleared in one click. You can also right-click a host in the table to set an exact-match / exclusion directly.

## Statistic definitions

Percentiles (P50 / P95 / P99): sort all request durations and take the value at the percentile position. Host-level P95 counts only that host's requests. Errors count status ≥ 400.

## FAQ

### Q: Can I export Insights?

The Insights page itself doesn't offer export. For raw data, use **Export HAR** on the Sessions page (all / filtered / Domain / selected scope).

### Q: Why do the numbers jump?

While capturing, the front end aggregates in real time and updates as new requests arrive; after stopping, it switches to the backend-persisted result and stabilizes. This is expected.

### Q: Is it normal for P95 to be much higher than the average?

Yes. The average is dragged down by many fast requests; P95 reflects the long tail and better represents the "slow portion" of the experience. Use the "Slowest requests" ranking to investigate.

### Q: Can I look at stats for just one host?

Yes. Use the host filter (keyword / exact match), or right-click a host in the table to set an exact filter; all metrics update accordingly.

### Q: The numbers don't match Sessions?

Make sure you're looking at the same workspace and the same set of sessions. Clearing a Sessions container empties Insights too.
