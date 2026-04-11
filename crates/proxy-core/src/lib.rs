#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyRuntimeConfig {
    pub port: u16,
    pub ssl_enabled: bool,
}

impl ProxyRuntimeConfig {
    pub fn validate(&self) -> Result<(), &'static str> {
        if self.port == 0 {
            return Err("proxy port must be greater than zero");
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::ProxyRuntimeConfig;

    #[test]
    fn validates_a_non_zero_port() {
        let config = ProxyRuntimeConfig {
            port: 8888,
            ssl_enabled: true,
        };

        let actual = config.validate();

        assert_eq!(actual, Ok(()));
    }

    #[test]
    fn rejects_zero_as_a_port() {
        let config = ProxyRuntimeConfig {
            port: 0,
            ssl_enabled: false,
        };

        let actual = config.validate();

        assert_eq!(actual, Err("proxy port must be greater than zero"));
    }
}
