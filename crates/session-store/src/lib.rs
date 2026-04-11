#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionPageRequest {
    pub limit: usize,
}

impl SessionPageRequest {
    pub fn normalized_limit(&self) -> usize {
        self.limit.clamp(1, 500)
    }
}

#[cfg(test)]
mod tests {
    use super::SessionPageRequest;

    #[test]
    fn clamps_limits_below_one() {
        let request = SessionPageRequest { limit: 0 };

        let actual = request.normalized_limit();

        assert_eq!(actual, 1);
    }

    #[test]
    fn clamps_limits_above_the_supported_page_size() {
        let request = SessionPageRequest { limit: 1_000 };

        let actual = request.normalized_limit();

        assert_eq!(actual, 500);
    }
}

