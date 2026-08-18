//! Built-in SSL proxying exclusions.
//!
//! Keep this module data-only so the recommended defaults stay separate from
//! the policy logic that consumes them.

/// Hosts excluded from interception when the user has not customized the list.
pub const DEFAULT_SSL_PROXYING_EXCLUSIONS: &[&str] = &[
    // ByteDance apps ship a security SDK that pins every first-party API
    // host, including the risk-control (`mssdk`) and asset (`gecko`)
    // channels.
    "*.tiktokv.com",
    "*.tiktokcdn.com",
    "*.tiktok-row.net",
    "*.snssdk.com",
    "*.byteoversea.com",
    // Pinned by iOS itself rather than by a third-party app, so no
    // certificate a user installs will ever be accepted for them.
    "*.icloud.com",
    "*.icloud.com.cn",
    "apps.apple.com",
    "*.apps.apple.com",
    "itunes.apple.com",
    "*.itunes.apple.com",
    // Google Play / Google account flows also tend to reject MITM
    // certificates, so keep them out of the default interception set.
    "play.googleapis.com",
    "android.clients.google.com",
    "*.googleapis.com",
    "*.gstatic.com",
    "*.googleusercontent.com",
    "accounts.google.com",
];
