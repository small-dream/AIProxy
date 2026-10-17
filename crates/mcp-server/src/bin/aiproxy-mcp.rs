use std::path::PathBuf;

use aiproxy_mcp::{AiProxyMcpServer, AppContext, AppPaths};
use clap::Parser;
use rmcp::ServiceExt;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Parser)]
#[command(
    name = "aiproxy-mcp",
    version,
    about = "Read-only MCP access to AIProxy traffic"
)]
struct Cli {
    #[arg(long, value_name = "PATH")]
    data_dir: Option<PathBuf>,
    #[arg(long, value_name = "PATH")]
    config: Option<PathBuf>,
    #[arg(long, default_value = "info")]
    log_level: String,
    #[arg(long)]
    doctor: bool,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let cli = Cli::parse();
    init_logging(&cli.log_level)?;

    let paths = AppPaths::resolve(cli.data_dir, cli.config).map_err(std::io::Error::other)?;
    let context = AppContext::new(paths);

    if cli.doctor {
        let result = context.doctor_result();
        println!("{}", serde_json::to_string_pretty(&result)?);
        if result.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
            std::process::exit(1);
        }
        return Ok(());
    }

    let service = AiProxyMcpServer::new(context)
        .serve(rmcp::transport::stdio())
        .await?;
    service.waiting().await?;
    Ok(())
}

fn init_logging(level: &str) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_new(level)?)
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .try_init()?;
    Ok(())
}
