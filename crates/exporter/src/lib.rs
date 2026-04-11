#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Curl,
    Har,
    Json,
}

impl ExportFormat {
    pub fn file_extension(self) -> &'static str {
        match self {
            Self::Curl => "txt",
            Self::Har => "har",
            Self::Json => "json",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::ExportFormat;

    #[test]
    fn maps_har_to_the_har_extension() {
        let actual = ExportFormat::Har.file_extension();

        assert_eq!(actual, "har");
    }

    #[test]
    fn maps_curl_to_a_text_extension() {
        let actual = ExportFormat::Curl.file_extension();

        assert_eq!(actual, "txt");
    }
}
