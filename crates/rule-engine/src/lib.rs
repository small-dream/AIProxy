#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleDescriptor {
    pub name: String,
    pub priority: u16,
}

impl RuleDescriptor {
    pub fn is_valid(&self) -> bool {
        !self.name.trim().is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::RuleDescriptor;

    #[test]
    fn accepts_a_named_rule() {
        let rule = RuleDescriptor {
            name: "Mock login endpoint".to_string(),
            priority: 10,
        };

        let actual = rule.is_valid();

        assert!(actual);
    }

    #[test]
    fn rejects_blank_rule_names() {
        let rule = RuleDescriptor {
            name: "   ".to_string(),
            priority: 10,
        };

        let actual = rule.is_valid();

        assert!(!actual);
    }
}
