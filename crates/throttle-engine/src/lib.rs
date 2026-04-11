#[derive(Debug, Clone, PartialEq)]
pub struct ThrottleProfile {
    pub latency_ms: u32,
    pub upload_kbps: u32,
    pub download_kbps: u32,
    pub packet_loss_ratio: f32,
}

impl ThrottleProfile {
    pub fn is_valid(&self) -> bool {
        (0.0..=1.0).contains(&self.packet_loss_ratio)
    }
}

#[cfg(test)]
mod tests {
    use super::ThrottleProfile;

    #[test]
    fn accepts_packet_loss_in_range() {
        let profile = ThrottleProfile {
            latency_ms: 200,
            upload_kbps: 128,
            download_kbps: 256,
            packet_loss_ratio: 0.25,
        };

        let actual = profile.is_valid();

        assert!(actual);
    }

    #[test]
    fn rejects_packet_loss_above_one_hundred_percent() {
        let profile = ThrottleProfile {
            latency_ms: 200,
            upload_kbps: 128,
            download_kbps: 256,
            packet_loss_ratio: 1.2,
        };

        let actual = profile.is_valid();

        assert!(!actual);
    }
}
