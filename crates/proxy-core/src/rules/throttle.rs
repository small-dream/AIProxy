use super::*;

/// Maximum transfer-delay sleep the throttle will impose in one call (M10).
///
/// Throttle delay is computed as `transfer_delay_ms(body_size, kbps)` and slept
/// in a single `sleep` before the first response byte is sent. For a large body
/// at a low rate this can be enormous (e.g. 200MB @ 1Mbps ≈ 27 minutes), during
/// which the connection/task appears hung. Capping the actual sleep bounds the
/// stall; the trace still reports the FULL computed delay so users see what the
/// configured rate WOULD impose, while the connection is not pinned for that
/// whole duration. 60s matches a typical interactive patience ceiling.
const MAX_THROTTLE_TRANSFER_DELAY_MS: u64 = 60_000;

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
    // M10: cap the actual transfer-delay sleep so a large upload at a low rate
    // cannot pin the connection for minutes/hours. The trace still records the
    // full computed `upload_delay_ms` (what the configured rate would impose).
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

pub(crate) async fn apply_response_throttle(
    selection: &ThrottleRuntimeSelection,
    body_len: usize,
) -> ThrottleTrace {
    let profile = &selection.profile;
    let download_delay_ms = transfer_delay_ms(body_len, profile.download_kbps);

    // M10: cap the actual transfer-delay sleep so a large download at a low
    // rate cannot pin the connection for minutes/hours (e.g. 200MB @ 1Mbps ≈
    // 27 min). The trace still records the full computed `download_delay_ms`.
    let capped_download_delay_ms = download_delay_ms.min(MAX_THROTTLE_TRANSFER_DELAY_MS);
    if capped_download_delay_ms > 0 {
        sleep(Duration::from_millis(capped_download_delay_ms)).await;
    }

    build_throttle_trace(
        selection,
        "response",
        "applied",
        body_len,
        0,
        download_delay_ms,
        None,
    )
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
}
