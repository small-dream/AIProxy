use super::*;

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
    if upload_delay_ms > 0 {
        sleep(Duration::from_millis(upload_delay_ms)).await;
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

    if download_delay_ms > 0 {
        sleep(Duration::from_millis(download_delay_ms)).await;
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
