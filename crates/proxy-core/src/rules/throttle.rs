use super::*;
use http_body_util::BodyExt;
use std::pin::Pin;

/// Maximum duration a single chunk-level throttle sleep may impose.
///
/// Under the per-chunk shaping model the response body is delivered one frame
/// at a time, sleeping `transfer_delay_ms(chunk_bytes, kbps)` before yielding
/// each data frame (see `ThrottledBody`). Because frames are small (the inner
/// stream's natural chunk size — 8 KiB for a spooled `ReaderStream`, one block
/// for an in-memory `Full<Bytes>`), a single frame's sleep is tiny at any sane
/// rate. This cap exists purely as a guard against pathological configurations
/// (e.g. an absurdly low `kbps` combined with an unusually large frame) so one
/// `poll_frame` cannot stall the connection for minutes. 60s matches a typical
/// interactive patience ceiling.
///
/// Note: the `ThrottleTrace` always reports the FULL theoretical
/// `transfer_delay_ms = transfer_delay_ms(total_bytes, kbps)` so users see what
/// the configured rate would impose over the whole body, regardless of this
/// per-chunk cap.
const MAX_THROTTLE_TRANSFER_DELAY_MS: u64 = 60_000;

/// Target size of each throttled sub-chunk emitted to the client.
///
/// `ThrottledBody` splits incoming data frames into pieces of at most this size
/// and gates each on its own sleep. This matters because some inner bodies emit
/// the whole response as a single frame — notably `Full<Bytes>`, which the proxy
/// uses for every in-memory response (bodies under `MAX_CAPTURED_BODY_BYTES`) and
/// all breakpoint mock responses. Without splitting, a 10 MiB `Full<Bytes>` body
/// would receive one upfront sleep for the entire transfer delay and then burst
/// out in a single frame, reproducing the very "sleep-then-dump" bug the wrapper
/// exists to fix. 16 KiB keeps the per-chunk delay tiny at any sane rate (e.g.
/// 16 KiB @ 1 KiB/s ≈ 128 ms) and matches a typical TLS record / TCP segment
/// granularity, so the client observes a steady drip of bytes.
const THROTTLE_CHUNK_BYTES: usize = 16 * 1024;

fn normalize_packet_loss_ratio(packet_loss_ratio: f32) -> f32 {
    if packet_loss_ratio <= 1.0 {
        // Treat values in [0, 1] as a ratio (e.g. 0.05 = 5% loss).
        // To express a percentage, use values > 1.0 (e.g. 5 = 5% loss).
        packet_loss_ratio.max(0.0)
    } else {
        (packet_loss_ratio / 100.0).clamp(0.0, 1.0)
    }
}

fn should_drop_for_packet_loss(profile: &ThrottleProfileData) -> bool {
    let normalized = normalize_packet_loss_ratio(profile.packet_loss_ratio);

    if normalized <= 0.0 {
        return false;
    }

    rand::random::<f32>() < normalized
}

fn transfer_delay_ms(byte_count: usize, kbps: u32) -> u64 {
    if byte_count == 0 || kbps == 0 {
        return 0;
    }

    let bits = (byte_count as u128) * 8;
    let bits_per_second = (kbps as u128) * 1024;
    let millis = (bits * 1_000).div_ceil(bits_per_second);

    millis as u64
}

pub(crate) async fn apply_request_throttle(
    selection: &ThrottleRuntimeSelection,
    body_len: usize,
) -> Result<ThrottleTrace, ThrottleFailure> {
    let profile = &selection.profile;
    if should_drop_for_packet_loss(profile) {
        let error = format!("request dropped by throttle profile '{}'", profile.name);
        return Err(ThrottleFailure {
            error: error.clone(),
            trace: build_throttle_trace(
                selection,
                "request",
                "dropped",
                body_len,
                0,
                0,
                Some(error),
            ),
        });
    }

    let latency_ms = profile.latency_ms as u64;
    let upload_delay_ms = transfer_delay_ms(body_len, profile.upload_kbps);

    if latency_ms > 0 {
        sleep(Duration::from_millis(latency_ms)).await;
    }
    // Request-side transfer delay is applied as a single upfront sleep because
    // the request body has already been fully buffered and handed to the
    // upstream client in `forward_request` — there is no streaming seam left to
    // shape per-chunk. Cap it so a large upload at a low rate cannot pin the
    // connection for minutes/hours. The trace still records the full computed
    // `upload_delay_ms` (what the configured rate would impose).
    //
    // (The response side, by contrast, shapes transfer delay per-chunk via
    // `ThrottledBody` — see `evaluate_response_throttle` below.)
    let capped_upload_delay_ms = upload_delay_ms.min(MAX_THROTTLE_TRANSFER_DELAY_MS);
    if capped_upload_delay_ms > 0 {
        sleep(Duration::from_millis(capped_upload_delay_ms)).await;
    }

    Ok(build_throttle_trace(
        selection,
        "request",
        "applied",
        body_len,
        latency_ms,
        upload_delay_ms,
        None,
    ))
}

/// Outcome of evaluating the response-stage throttle, short of actually
/// shaping the body.
///
/// `evaluate_response_throttle` sleeps the fixed `latency_ms` (modelling the
/// upstream → client RTT) and decides whether the response is dropped by
/// packet loss. It does NOT sleep the transfer delay: that is applied
/// per-chunk by wrapping the response body in a `ThrottledBody` (see
/// `throttle_response_body`), so a large download is delivered gradually at
/// the configured `download_kbps` instead of being buffered and dumped all at
/// once. The `trace` still reports the FULL theoretical transfer delay so the
/// UI reflects what the configured rate would impose over the whole body.
#[derive(Debug)]
pub(crate) struct ResponseThrottlePlan {
    pub trace: ThrottleTrace,
    /// Configured download rate. `0` means "no transfer shaping" — the caller
    /// may skip wrapping the body entirely (see `throttle_response_body`).
    pub download_kbps: u32,
}

/// Evaluate the response-stage throttle for `body_len` bytes.
///
/// - Packet loss is applied symmetrically with the request stage: a drop
///   returns `Err(ThrottleFailure)` and the caller emits a 504.
/// - `latency_ms` is slept here (models upstream → client RTT).
/// - The transfer delay is NOT slept here. It is reported in the trace as the
///   full theoretical value, and the caller shapes it per-chunk by wrapping the
///   response body via `throttle_response_body(plan.download_kbps, ...)`.
pub(crate) async fn evaluate_response_throttle(
    selection: &ThrottleRuntimeSelection,
    body_len: usize,
) -> Result<ResponseThrottlePlan, ThrottleFailure> {
    let profile = &selection.profile;

    // M9: apply response-stage packet loss symmetrically with the request
    // stage. Dropping the response means the client observes the configured
    // loss on the downstream leg too, not just on requests.
    if should_drop_for_packet_loss(profile) {
        let error = format!("response dropped by throttle profile '{}'", profile.name);
        return Err(ThrottleFailure {
            error: error.clone(),
            trace: build_throttle_trace(
                selection,
                "response",
                "dropped",
                body_len,
                0,
                0,
                Some(error),
            ),
        });
    }

    // M9: apply latency_ms on the response leg (previously only the request
    // leg slept for latency). This models upstream → client RTT symmetrically.
    let latency_ms = profile.latency_ms as u64;
    let download_delay_ms = transfer_delay_ms(body_len, profile.download_kbps);

    if latency_ms > 0 {
        sleep(Duration::from_millis(latency_ms)).await;
    }

    // M5/M6 fix: do NOT sleep `download_delay_ms` here. Doing so (the previous
    // behaviour) meant a large body was fully buffered, slept for up to the
    // 60s cap, and then dumped to the client all at once — so `download_kbps`
    // had no real shaping effect ("I enabled throttling but nothing slowed
    // down"). Instead the transfer delay is applied per-chunk by
    // `ThrottledBody`; the trace continues to report the full theoretical
    // `download_delay_ms` so the UI shows what the configured rate implies.

    Ok(ResponseThrottlePlan {
        trace: build_throttle_trace(
            selection,
            "response",
            "applied",
            body_len,
            latency_ms,
            download_delay_ms,
            None,
        ),
        download_kbps: profile.download_kbps,
    })
}

/// A buffered data slice awaiting its throttle sleep before being emitted.
///
/// `ThrottledBody` splits incoming data frames into sub-chunks of at most
/// `THROTTLE_CHUNK_BYTES` and gates each on its own `Sleep`. `remaining` holds
/// the bytes not yet emitted; after a sleep elapses one `THROTTLE_CHUNK_BYTES`
/// slice is yielded and, if bytes remain, a new sleep is armed for the next
/// slice. The `Sleep` is pin-boxed so this stays `Unpin` (and thus
/// `ThrottledBody` is `Unpin`, matching the proxy's body-handling conventions).
struct PendingChunk {
    remaining: bytes::Bytes,
    sleep: Pin<Box<tokio::time::Sleep>>,
}

/// A `http_body::Body` wrapper that shapes download bandwidth.
///
/// Each emitted data sub-chunk is preceded by a sleep of
/// `transfer_delay_ms(chunk_bytes, download_kbps)` (capped at
/// `MAX_THROTTLE_TRANSFER_DELAY_MS`), so the client observes a gradual,
/// rate-limited delivery rather than receiving the whole buffered body in one
/// burst. Data frames from the inner body are split into sub-chunks of at most
/// `THROTTLE_CHUNK_BYTES` before gating — this is essential because some inner
/// bodies (notably `Full<Bytes>`, used for every in-memory response and all
/// breakpoint mocks) emit the entire body as a single frame, which would
/// otherwise reproduce the "sleep-then-dump" bug this wrapper exists to fix.
/// Non-data frames (trailers) are passed through without delay. When
/// `download_kbps == 0` no shaping is applied — prefer constructing this only
/// when shaping is needed (see `throttle_response_body`).
pub(crate) struct ThrottledBody<B> {
    inner: B,
    download_kbps: u32,
    pending: Option<PendingChunk>,
}

impl<B> ThrottledBody<B>
where
    B: http_body::Body<Data = bytes::Bytes>,
{
    pub(crate) fn new(inner: B, download_kbps: u32) -> Self {
        Self {
            inner,
            download_kbps,
            pending: None,
        }
    }

    /// Buffer `data` as the pending chunk and arm a sleep for its first
    /// `THROTTLE_CHUNK_BYTES` slice. The slice itself is NOT yielded here — it
    /// will be sliced off and yielded once the sleep elapses (in the pending
    /// branch of `poll_frame`). Any remainder stays in `pending.remaining` and
    /// is paced by subsequent re-arms. This avoids discarding the first slice
    /// of a freshly pulled frame.
    fn arm_chunk_sleep(&mut self, data: bytes::Bytes, cx: &mut std::task::Context<'_>) {
        let first_slice = THROTTLE_CHUNK_BYTES.min(data.len());
        let delay_ms = chunk_delay_ms(first_slice, self.download_kbps);
        let mut sleep = Box::pin(tokio::time::sleep(Duration::from_millis(delay_ms)));
        // Register the waker so the caller returning Pending below still gets
        // woken when the deadline elapses.
        use std::future::Future;
        let _ = sleep.as_mut().poll(cx);
        self.pending = Some(PendingChunk {
            remaining: data,
            sleep,
        });
    }
}

/// Per-sub-chunk sleep, in ms. Capped at `MAX_THROTTLE_TRANSFER_DELAY_MS`.
fn chunk_delay_ms(chunk_bytes: usize, download_kbps: u32) -> u64 {
    let mut ms = transfer_delay_ms(chunk_bytes, download_kbps);
    if ms > MAX_THROTTLE_TRANSFER_DELAY_MS {
        ms = MAX_THROTTLE_TRANSFER_DELAY_MS;
    }
    ms
}

impl<B> http_body::Body for ThrottledBody<B>
where
    B: http_body::Body<Data = bytes::Bytes> + Unpin,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    type Data = bytes::Bytes;
    type Error = B::Error;

    fn poll_frame(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Result<http_body::Frame<Self::Data>, Self::Error>>> {
        let this = self.get_mut();

        // If a sub-chunk is pending (its sleep armed), drive that sleep first.
        // When it elapses, yield the slice and — if bytes remain — arm the next
        // sub-chunk's sleep so the *following* poll is properly paced.
        if let Some(mut pending) = this.pending.take() {
            use std::future::Future;
            match pending.sleep.as_mut().poll(cx) {
                std::task::Poll::Ready(()) => {
                    let take = THROTTLE_CHUNK_BYTES.min(pending.remaining.len());
                    let chunk = pending.remaining.slice(..take);
                    let rest = pending.remaining.slice(take..);
                    if rest.is_empty() {
                        this.pending = None;
                    } else {
                        // Re-arm for the next sub-chunk. Poll registers the
                        // waker; we ignore the result because we yield `chunk`
                        // now regardless (this slice's sleep already elapsed).
                        let delay_ms = chunk_delay_ms(
                            rest.len().min(THROTTLE_CHUNK_BYTES),
                            this.download_kbps,
                        );
                        let mut sleep =
                            Box::pin(tokio::time::sleep(Duration::from_millis(delay_ms)));
                        let _ = sleep.as_mut().poll(cx);
                        this.pending = Some(PendingChunk {
                            remaining: rest,
                            sleep,
                        });
                    }
                    return std::task::Poll::Ready(Some(Ok(http_body::Frame::data(chunk))));
                }
                std::task::Poll::Pending => {
                    this.pending = Some(pending);
                    return std::task::Poll::Pending;
                }
            }
        }

        // Nothing pending: pull the next frame from the inner body.
        let frame = match Pin::new(&mut this.inner).poll_frame(cx) {
            std::task::Poll::Ready(Some(Ok(frame))) => frame,
            std::task::Poll::Ready(Some(Err(e))) => {
                return std::task::Poll::Ready(Some(Err(e)));
            }
            std::task::Poll::Ready(None) => return std::task::Poll::Ready(None),
            std::task::Poll::Pending => return std::task::Poll::Pending,
        };

        // Non-data frames (e.g. trailers) are forwarded without delay.
        let data = match frame.into_data() {
            Ok(data) => data,
            Err(frame) => return std::task::Poll::Ready(Some(Ok(frame))),
        };

        // No rate or empty frame: yield immediately.
        if this.download_kbps == 0 || data.is_empty() {
            return std::task::Poll::Ready(Some(Ok(http_body::Frame::data(data))));
        }

        // Buffer the whole frame as `pending` and arm a sleep for its first
        // sub-chunk. Return Pending; once the sleep elapses the pending branch
        // above yields the first `THROTTLE_CHUNK_BYTES` slice and re-arms for
        // the next, pacing the whole frame at the configured rate.
        this.arm_chunk_sleep(data, cx);
        std::task::Poll::Pending
    }

    fn is_end_stream(&self) -> bool {
        self.pending.is_none() && self.inner.is_end_stream()
    }

    fn size_hint(&self) -> http_body::SizeHint {
        // Throttling does not change the byte count, only the delivery cadence,
        // so the inner body's size hint is authoritative.
        self.inner.size_hint()
    }
}

/// Wrap a response body with per-chunk download throttling.
///
/// Returns the body unchanged when `download_kbps == 0` (no shaping) so the
/// non-throttled fast path stays allocation-free. Otherwise the body is boxed
/// to the proxy's canonical `BoxBody<Bytes, String>`-compatible erased type.
pub(crate) fn throttle_response_body<B>(
    body: B,
    download_kbps: u32,
) -> http_body_util::combinators::BoxBody<bytes::Bytes, B::Error>
where
    B: http_body::Body<Data = bytes::Bytes> + Send + Sync + Unpin + 'static,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>> + Send + Sync + 'static,
{
    if download_kbps == 0 {
        return BodyExt::boxed(body);
    }
    BodyExt::boxed(ThrottledBody::new(body, download_kbps))
}

fn build_throttle_trace(
    selection: &ThrottleRuntimeSelection,
    stage: &str,
    outcome: &str,
    body_bytes: usize,
    latency_ms: u64,
    transfer_delay_ms: u64,
    message: Option<String>,
) -> ThrottleTrace {
    let rule = selection.rule.as_ref();
    ThrottleTrace {
        body_bytes,
        delay_ms: latency_ms.saturating_add(transfer_delay_ms),
        latency_ms,
        message,
        outcome: outcome.to_string(),
        profile_id: selection.profile.id.clone(),
        profile_name: selection.profile.name.clone(),
        rule_id: rule.map(|rule| rule.id.clone()),
        rule_name: rule.map(|rule| rule.name.clone()),
        sequence: 0,
        stage: stage.to_string(),
        transfer_delay_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transfer_delay_zero_for_empty_or_zero_rate() {
        assert_eq!(transfer_delay_ms(0, 1024), 0);
        assert_eq!(transfer_delay_ms(1024, 0), 0);
    }

    // 1 KiB at 1 KiB/s (kbps=1 → 1024 bits/s) = 8192 bits / 1024 bps = 8s = 8000ms.
    #[test]
    fn transfer_delay_computes_expected_ms() {
        assert_eq!(transfer_delay_ms(1024, 1), 8_000);
    }

    // M10 regression guard: huge bodies must not overflow u64 / panic. u128
    // arithmetic keeps this well within range.
    #[test]
    fn transfer_delay_handles_huge_body_without_overflow() {
        let delay = transfer_delay_ms(usize::MAX, 1);
        assert!(delay > 0);
    }

    #[test]
    fn normalize_packet_loss_clamps_and_divides() {
        assert_eq!(normalize_packet_loss_ratio(0.0), 0.0);
        assert_eq!(normalize_packet_loss_ratio(0.05), 0.05);
        assert_eq!(normalize_packet_loss_ratio(5.0), 0.05);
        assert_eq!(normalize_packet_loss_ratio(150.0), 1.0);
        assert_eq!(normalize_packet_loss_ratio(-1.0), 0.0);
    }

    // --- M9: response throttle latency + drop symmetry ----------------------

    fn test_profile(latency_ms: u32, packet_loss_ratio: f32) -> ThrottleProfileData {
        ThrottleProfileData {
            id: "p1".to_string(),
            download_kbps: 0,
            enabled: true,
            latency_ms,
            name: "test".to_string(),
            note: None,
            packet_loss_ratio,
            preset: false,
            upload_kbps: 0,
            workspace_id: "default".to_string(),
        }
    }

    fn test_selection(profile: ThrottleProfileData) -> ThrottleRuntimeSelection {
        ThrottleRuntimeSelection {
            profile,
            rule: None,
        }
    }

    // M9-1: response trace records the configured latency_ms (was hard-coded 0),
    // so `delay_ms` reflects the true stall and downstream clients observe RTT.
    // Uses a small latency to keep the test fast (the sleep is real).
    #[tokio::test]
    async fn response_throttle_records_configured_latency_in_trace() {
        // latency only (no transfer delay since kbps == 0); packet loss == 0
        // so the response is never dropped.
        let selection = test_selection(test_profile(5, 0.0));
        let plan = evaluate_response_throttle(&selection, 0)
            .await
            .expect("0% loss never drops");
        assert_eq!(
            plan.trace.latency_ms, 5,
            "response latency_ms must be recorded"
        );
        assert_eq!(plan.trace.delay_ms, 5, "delay_ms includes latency");
        assert_eq!(plan.trace.outcome, "applied");
        assert_eq!(plan.trace.stage, "response");
    }

    // M9-2: 100% packet loss drops the response (returns Err), symmetric with
    // the request stage. The drop trace carries outcome == "dropped".
    #[tokio::test]
    async fn response_throttle_drops_on_full_packet_loss() {
        let selection = test_selection(test_profile(0, 1.0));
        let failure = evaluate_response_throttle(&selection, 1024)
            .await
            .expect_err("100% loss must drop the response");
        assert_eq!(failure.trace.outcome, "dropped");
        assert_eq!(failure.trace.stage, "response");
        assert!(failure.error.contains("response dropped"));
    }

    // M5/M6 fix: evaluate_response_throttle must NOT sleep the transfer delay
    // for large bodies — that is now the body wrapper's job. A 1 MiB body at
    // 1 KiB/s would theoretically take ~2.3 hours; if the function slept it,
    // this test would hang. We assert it returns well within a couple seconds
    // (only the latency_ms is slept), while the trace still reports the full
    // theoretical transfer delay.
    #[tokio::test]
    async fn evaluate_response_throttle_does_not_sleep_transfer_delay() {
        // 1 MiB body, 1 KiB/s download rate, 0 latency (to isolate transfer
        // delay). Theoretical transfer delay = (1 MiB * 8 bits) / 1024 bps
        // = 8192 s ≈ 2.3 hours. The function must return in seconds, not hours.
        let profile = ThrottleProfileData {
            download_kbps: 1,
            latency_ms: 0,
            ..test_profile(0, 0.0)
        };
        let selection = test_selection(profile);
        let body_len = 1024 * 1024;

        let start = std::time::Instant::now();
        let plan = evaluate_response_throttle(&selection, body_len)
            .await
            .expect("0% loss never drops");
        let elapsed = start.elapsed();

        // Returned quickly (only latency_ms=0 was slept; certainly not 8192s).
        assert!(
            elapsed.as_secs() < 3,
            "evaluate_response_throttle should return in seconds, took {elapsed:?}"
        );
        // Trace still reports the full theoretical transfer delay.
        assert_eq!(
            plan.trace.transfer_delay_ms,
            transfer_delay_ms(body_len, 1),
            "trace must report the full theoretical transfer delay"
        );
        assert_eq!(plan.download_kbps, 1);
    }

    // --- ThrottledBody -------------------------------------------------------

    // Helper: drive a Body to completion and collect (frame_bytes_len, instant
    // yielded) for each data frame. `Full<Bytes>` never errors, so the frame
    // result is always `Ok`.
    async fn collect_throttled_frames(
        body: ThrottledBody<http_body_util::Full<bytes::Bytes>>,
    ) -> Vec<(usize, std::time::Instant)> {
        use http_body_util::BodyExt as _;
        use std::pin::pin;
        let mut body = pin!(body);
        let mut out = Vec::new();
        while let Some(Ok(frame)) = body.frame().await {
            if let Some(data) = frame.data_ref() {
                out.push((data.len(), std::time::Instant::now()));
            }
        }
        out
    }

    // kbps == 0 → no shaping: all frames yield immediately (no per-frame
    // sleep). This guards the no-op fast path so throttling code never runs
    // for unthrottled responses.
    #[tokio::test]
    async fn throttled_body_zero_kbps_is_passthrough() {
        // 64 KiB body wrapped as a single Full<Bytes> frame, kbps == 0.
        let body = http_body_util::Full::new(bytes::Bytes::from(vec![0u8; 65_536]));
        let throttled = ThrottledBody::new(body, 0);

        let start = std::time::Instant::now();
        let frames = collect_throttled_frames(throttled).await;
        let elapsed = start.elapsed();

        assert_eq!(frames.len(), 1, "single Full<Bytes> yields one data frame");
        assert_eq!(frames[0].0, 65_536);
        assert!(
            elapsed.as_millis() < 100,
            "kbps=0 must not sleep, took {elapsed:?}"
        );
    }

    // Non-zero kbps shapes delivery: a body whose theoretical transfer delay is
    // large must take roughly that long to drain (not return instantly, and not
    // be capped to some smaller value). Use a multi-chunk stream so we exercise
    // the per-frame sleep repeatedly.
    #[tokio::test]
    async fn throttled_body_yields_at_configured_rate() {
        use futures_util::stream;
        use http_body_util::StreamBody;

        // Two 1 KiB chunks. At 1 KiB/s each chunk takes ~8s (8192 bits / 1024
        // bps). That's too slow for a unit test, so use a higher rate: 256 KiB/s
        // → 1 KiB takes 8192 bits / (256*1024 bps) ≈ 31 ms per chunk. Two chunks
        // ≈ 62 ms total. We assert total elapsed is in the right ballpark.
        let chunk = bytes::Bytes::from(vec![0u8; 1024]);
        let frames: Vec<Result<http_body::Frame<bytes::Bytes>, std::convert::Infallible>> = vec![
            Ok(http_body::Frame::data(chunk.clone())),
            Ok(http_body::Frame::data(chunk)),
        ];
        let stream = stream::iter(frames);
        let inner = StreamBody::new(stream);
        let throttled = ThrottledBody::new(inner, 256);

        let start = std::time::Instant::now();
        // Drive it manually via frame() to measure per-frame timing. StreamBody
        // over an Infallible stream never errors, so each frame is always Ok.
        use http_body_util::BodyExt as _;
        use std::pin::pin;
        let mut body = pin!(throttled);
        let mut yielded = Vec::new();
        while let Some(Ok(frame)) = body.frame().await {
            if let Some(data) = frame.data_ref() {
                yielded.push((data.len(), start.elapsed()));
            }
        }
        let elapsed = start.elapsed();

        assert_eq!(yielded.len(), 2, "both chunks must be delivered");
        assert_eq!(yielded[0].0 + yielded[1].0, 2048);

        let per_chunk_ms = transfer_delay_ms(1024, 256); // ≈ 31 ms
        let expected_total_ms = per_chunk_ms * 2; // ≈ 62 ms

        // Sanity: took meaningfully longer than a no-op (allow scheduler slack).
        assert!(
            elapsed.as_millis() as u64 >= expected_total_ms.saturating_sub(20),
            "throttle should slow delivery; expected ~{expected_total_ms}ms, took {elapsed:?}"
        );
        // And not absurdly longer (no 60s cap kicking in here).
        assert!(
            elapsed.as_secs() < 2,
            "throttle should not over-delay; took {elapsed:?}"
        );
        // Second chunk delivered later than the first (proves per-chunk shaping).
        assert!(
            yielded[1].1 > yielded[0].1,
            "second chunk should be delayed relative to the first"
        );
    }

    // Regression for the reviewer finding (M5/M6 follow-up): a body that the
    // inner `Full<Bytes>` emits as a SINGLE frame — which is exactly the case
    // for every in-memory upstream response (under MAX_CAPTURED_BODY_BYTES) and
    // all breakpoint mock responses — must still be split into THROTTLE_CHUNK_BYTES
    // sub-chunks and paced. Otherwise the whole body gets one upfront sleep and
    // bursts out in a single frame, reproducing the original "sleep-then-dump"
    // bug the wrapper exists to fix.
    //
    // We use a 48 KiB Full<Bytes> (3 × THROTTLE_CHUNK_BYTES of 16 KiB) at a rate
    // chosen so each 16 KiB sub-chunk takes a measurable but test-fast delay.
    #[tokio::test]
    async fn throttled_body_splits_single_frame_into_paced_subchunks() {
        // 3 sub-chunks of 16 KiB. At 4096 KiB/s, 16 KiB takes:
        //   (16*1024 * 8 bits) / (4096*1024 bps) = 131072 / 4194304 ≈ 0.031s →
        //   div_ceil → 32 ms per sub-chunk. 3 sub-chunks ≈ 96 ms total.
        let total_bytes = THROTTLE_CHUNK_BYTES * 3;
        let body = http_body_util::Full::new(bytes::Bytes::from(vec![0u8; total_bytes]));
        let throttled = ThrottledBody::new(body, 4096);

        let start = std::time::Instant::now();
        let frames = collect_throttled_frames(throttled).await;
        let elapsed = start.elapsed();

        // Must be split into multiple sub-chunks — NOT delivered as one frame.
        // This is the core assertion: without splitting, frames.len() == 1.
        assert_eq!(
            frames.len(),
            3,
            "single Full<Bytes> frame must be split into 3 sub-chunks, got {}",
            frames.len()
        );
        // All bytes delivered, each sub-chunk capped at THROTTLE_CHUNK_BYTES.
        for (len, _) in &frames {
            assert!(
                *len <= THROTTLE_CHUNK_BYTES,
                "sub-chunk {len} exceeds THROTTLE_CHUNK_BYTES ({THROTTLE_CHUNK_BYTES})"
            );
        }
        assert_eq!(
            frames.iter().map(|(l, _)| *l).sum::<usize>(),
            total_bytes,
            "all bytes must be delivered"
        );
        // Each successive sub-chunk is delivered later than the previous —
        // proving per-sub-chunk pacing rather than a single burst.
        for window in frames.windows(2) {
            assert!(
                window[1].1 > window[0].1,
                "sub-chunks must be paced (later ones delivered later)"
            );
        }
        // And the total time reflects ~3 sub-chunk delays, not a single burst.
        let per_sub_ms = transfer_delay_ms(THROTTLE_CHUNK_BYTES, 4096); // ≈ 32 ms
        assert!(
            elapsed.as_millis() as u64 >= per_sub_ms * 2,
            "delivery should take ~{}ms (3 paced sub-chunks), took {elapsed:?}",
            per_sub_ms * 3
        );
    }
}
