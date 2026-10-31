// `ToolError` intentionally carries structured details for the Agent (a JSON
// `Value`, which is larger than usual because serde_json is built with the
// `preserve_order` feature that keeps rewritten bodies byte-faithful). That puts
// the type at clippy's 128-byte threshold. Boxing it would ripple through every
// tool signature for no runtime benefit: tool errors are cold, one-per-failed-call
// values, while results are what run hot.
#![allow(clippy::result_large_err)]

pub mod audit;
pub mod config;
pub mod context;
pub mod control_client;
pub mod protocol;
pub mod redaction;
pub mod server;
pub mod status;
pub mod tools;

pub use config::AppPaths;
pub use context::AppContext;
pub use server::AiProxyMcpServer;
