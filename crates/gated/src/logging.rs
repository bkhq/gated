use std::sync::Arc;

use anyhow::{Context, Result};
use gated_common::{GatedConfig, LogConfig, LogFileRotation, LogFormat};
use gated_core::logging::{
    make_database_logger_layer, make_json_console_logger_layer, make_socket_logger_layer,
};
use time::{format_description, UtcOffset};
use tracing::Subscriber;
use tracing_log::LogTracer;
use tracing_subscriber::filter::dynamic_filter_fn;
use tracing_subscriber::fmt::time::OffsetTime;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

use crate::Cli;

/// Guards that must outlive the global subscriber. Drop (or call
/// [`LoggingGuards::shutdown`]) at process exit to flush buffered writes and
/// OTLP exports.
#[must_use = "drop the guard at process exit or buffered logs will be lost"]
pub struct LoggingGuards {
    _file_guard: Option<tracing_appender::non_blocking::WorkerGuard>,
    #[cfg(feature = "otel")]
    otel_provider: Option<opentelemetry_sdk::trace::TracerProvider>,
}

impl LoggingGuards {
    pub fn shutdown(self) {
        #[cfg(feature = "otel")]
        if let Some(provider) = self.otel_provider {
            if let Err(e) = provider.shutdown() {
                eprintln!("OTel tracer shutdown failed: {e:?}");
            }
        }
    }
}

pub async fn init_logging(config: Option<&GatedConfig>, cli: &Cli) -> Result<LoggingGuards> {
    let log_cfg = config.map(|c| &c.store.log);

    LogTracer::init().context("Failed to initialize log compatibility layer")?;

    let offset = UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC);
    let enable_colors = console::user_attended();

    let log_format = cli
        .log_format
        .or(log_cfg.map(|c| c.format))
        .unwrap_or_default();

    let default_filter: Arc<EnvFilter> = Arc::new(EnvFilter::new(default_log_directive(
        std::env::var("RUST_LOG").ok(),
        cli.debug,
        log_cfg,
    )));

    let socket_layer = match config {
        Some(config) => Some(make_socket_logger_layer(config).await),
        None => None,
    };

    let console_filter = resolve_sink_filter(
        log_cfg.and_then(|c| c.console.level.as_deref()),
        &default_filter,
    )?;

    // Preparation for file sink (file handle/guard + config snapshot); layers
    // constructed via generic helpers below.
    let file_prep = prepare_file_sink(log_cfg, log_format, &default_filter)?;

    // OTel preparation (tracer + filter) — the `Layer` itself is built via a
    // generic helper so its `S` parameter is inferred against the real
    // subscriber chain.
    #[cfg(feature = "otel")]
    let otel_prep = prepare_otel_sink(log_cfg, &default_filter)?;

    let registry = tracing_subscriber::registry()
        .with(console_json_layer(log_format, console_filter.clone()))
        .with(console_text_non_interactive_layer(
            log_format,
            enable_colors,
            offset,
            console_filter.clone(),
        ))
        .with(console_text_interactive_layer(
            log_format,
            enable_colors,
            offset,
            console_filter,
        ))
        .with(file_json_layer(&file_prep))
        .with(file_text_layer(&file_prep, offset))
        .with(make_database_logger_layer())
        .with(socket_layer);

    #[cfg(feature = "otel")]
    let registry = registry.with(otel_layer(&otel_prep));

    registry.init();

    Ok(LoggingGuards {
        _file_guard: file_prep.guard,
        #[cfg(feature = "otel")]
        otel_provider: otel_prep.provider,
    })
}

// ---------------------------------------------------------------------------
// Filter helpers
// ---------------------------------------------------------------------------

/// Default filter directive from the first source that has a value:
/// `RUST_LOG` env > CLI `--debug` > `config.log.level` > hardcoded default.
fn default_log_directive(
    rust_log: Option<String>,
    debug: u8,
    log_cfg: Option<&LogConfig>,
) -> String {
    if let Some(directive) = rust_log {
        return directive;
    }

    match debug {
        0 => {}
        1 => return "gated=debug".to_owned(),
        2 => return "gated=debug,russh=debug".to_owned(),
        _ => return "debug".to_owned(),
    }

    log_cfg
        .and_then(|c| c.level.as_deref())
        .filter(|level| !level.is_empty())
        .unwrap_or("gated=info")
        .to_owned()
}

fn resolve_sink_filter(
    override_directive: Option<&str>,
    default: &Arc<EnvFilter>,
) -> Result<Arc<EnvFilter>> {
    match override_directive.filter(|d| !d.is_empty()) {
        None => Ok(default.clone()),
        Some(d) => {
            Ok(Arc::new(EnvFilter::try_new(d).with_context(|| {
                format!("invalid log level directive {d:?}")
            })?))
        }
    }
}

fn make_timer(
    offset: UtcOffset,
    pattern: &'static str,
) -> OffsetTime<Vec<time::format_description::BorrowedFormatItem<'static>>> {
    #[allow(clippy::unwrap_used, reason = "static format description is valid")]
    OffsetTime::new(
        offset,
        format_description::parse_borrowed::<1>(pattern).unwrap(),
    )
}

// ---------------------------------------------------------------------------
// Console layers (generic over S)
// ---------------------------------------------------------------------------

fn console_json_layer<S>(format: LogFormat, filter: Arc<EnvFilter>) -> Option<impl Layer<S>>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    if format != LogFormat::Json {
        return None;
    }
    let f = filter;
    Some(
        make_json_console_logger_layer()
            .with_filter(dynamic_filter_fn(move |m, c| f.enabled(m, c.clone()))),
    )
}

fn console_text_non_interactive_layer<S>(
    format: LogFormat,
    enable_colors: bool,
    offset: UtcOffset,
    filter: Arc<EnvFilter>,
) -> Option<impl Layer<S>>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    if format != LogFormat::Text || console::user_attended() {
        return None;
    }
    let f = filter;
    Some(
        tracing_subscriber::fmt::layer()
            .with_ansi(enable_colors)
            .with_timer(make_timer(
                offset,
                "[day].[month].[year] [hour]:[minute]:[second]",
            ))
            .with_filter(dynamic_filter_fn(move |m, c| f.enabled(m, c.clone()))),
    )
}

fn console_text_interactive_layer<S>(
    format: LogFormat,
    enable_colors: bool,
    offset: UtcOffset,
    filter: Arc<EnvFilter>,
) -> Option<impl Layer<S>>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    if format != LogFormat::Text || !console::user_attended() {
        return None;
    }
    let f = filter;
    Some(
        tracing_subscriber::fmt::layer()
            .compact()
            .with_ansi(enable_colors)
            .with_target(false)
            .with_timer(make_timer(offset, "[hour]:[minute]:[second]"))
            .with_filter(dynamic_filter_fn(move |m, c| f.enabled(m, c.clone()))),
    )
}

// ---------------------------------------------------------------------------
// File sink
// ---------------------------------------------------------------------------

struct FileSinkPrep {
    writer: Option<tracing_appender::non_blocking::NonBlocking>,
    filter: Option<Arc<EnvFilter>>,
    format: Option<LogFormat>,
    guard: Option<tracing_appender::non_blocking::WorkerGuard>,
}

fn prepare_file_sink(
    log_cfg: Option<&LogConfig>,
    global_format: LogFormat,
    default_filter: &Arc<EnvFilter>,
) -> Result<FileSinkPrep> {
    let Some(file_cfg) = log_cfg.map(|c| &c.file).filter(|f| f.enable) else {
        return Ok(FileSinkPrep {
            writer: None,
            filter: None,
            format: None,
            guard: None,
        });
    };

    let directory = file_cfg
        .directory
        .clone()
        .unwrap_or_else(|| std::path::PathBuf::from("./data/logs"));

    std::fs::create_dir_all(&directory)
        .with_context(|| format!("create log directory {}", directory.display()))?;

    let rotation = match file_cfg.rotation {
        LogFileRotation::Daily => tracing_appender::rolling::Rotation::DAILY,
        LogFileRotation::Hourly => tracing_appender::rolling::Rotation::HOURLY,
        LogFileRotation::Minutely => tracing_appender::rolling::Rotation::MINUTELY,
        LogFileRotation::Never => tracing_appender::rolling::Rotation::NEVER,
    };
    let appender = tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(rotation)
        .filename_prefix(&file_cfg.prefix)
        .filename_suffix("log")
        .build(&directory)
        .with_context(|| format!("open rolling appender in {}", directory.display()))?;
    let (non_blocking, guard) = tracing_appender::non_blocking(appender);

    Ok(FileSinkPrep {
        writer: Some(non_blocking),
        filter: Some(resolve_sink_filter(
            file_cfg.level.as_deref(),
            default_filter,
        )?),
        format: Some(file_cfg.format.unwrap_or(global_format)),
        guard: Some(guard),
    })
}

fn file_json_layer<S>(prep: &FileSinkPrep) -> Option<impl Layer<S>>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    let writer = prep.writer.clone()?;
    if prep.format != Some(LogFormat::Json) {
        return None;
    }
    let filter = prep.filter.clone()?;
    Some(
        tracing_subscriber::fmt::layer()
            .json()
            .with_writer(writer)
            .with_filter(dynamic_filter_fn(move |m, c| filter.enabled(m, c.clone()))),
    )
}

fn file_text_layer<S>(prep: &FileSinkPrep, offset: UtcOffset) -> Option<impl Layer<S>>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    let writer = prep.writer.clone()?;
    if prep.format != Some(LogFormat::Text) {
        return None;
    }
    let filter = prep.filter.clone()?;
    Some(
        tracing_subscriber::fmt::layer()
            .with_ansi(false)
            .with_writer(writer)
            .with_timer(make_timer(
                offset,
                "[day].[month].[year] [hour]:[minute]:[second]",
            ))
            .with_filter(dynamic_filter_fn(move |m, c| filter.enabled(m, c.clone()))),
    )
}

// ---------------------------------------------------------------------------
// OpenTelemetry sink
// ---------------------------------------------------------------------------

#[cfg(feature = "otel")]
struct OtelSinkPrep {
    tracer: Option<opentelemetry_sdk::trace::Tracer>,
    filter: Option<Arc<EnvFilter>>,
    provider: Option<opentelemetry_sdk::trace::TracerProvider>,
}

#[cfg(feature = "otel")]
fn prepare_otel_sink(
    log_cfg: Option<&LogConfig>,
    default_filter: &Arc<EnvFilter>,
) -> Result<OtelSinkPrep> {
    use gated_common::OtlpProtocol;
    use opentelemetry::trace::TracerProvider as _;
    use opentelemetry::KeyValue;
    use opentelemetry_otlp::{SpanExporter, WithExportConfig};
    use opentelemetry_sdk::trace::TracerProvider;
    use opentelemetry_sdk::Resource;

    let Some(otlp_cfg) = log_cfg.and_then(|c| c.otlp.as_ref()) else {
        return Ok(OtelSinkPrep {
            tracer: None,
            filter: None,
            provider: None,
        });
    };

    let exporter = match otlp_cfg.protocol {
        OtlpProtocol::Grpc => {
            use opentelemetry_otlp::WithTonicConfig;
            let mut builder = SpanExporter::builder()
                .with_tonic()
                .with_endpoint(&otlp_cfg.endpoint);
            if !otlp_cfg.headers.is_empty() {
                let mut metadata = tonic::metadata::MetadataMap::new();
                for (k, v) in &otlp_cfg.headers {
                    let key: tonic::metadata::MetadataKey<_> = k
                        .parse()
                        .with_context(|| format!("invalid OTLP header name {k:?}"))?;
                    let value = v
                        .parse()
                        .with_context(|| format!("invalid OTLP header value for {k:?}"))?;
                    metadata.insert(key, value);
                }
                builder = builder.with_metadata(metadata);
            }
            builder.build().context("build OTLP gRPC exporter")?
        }
        OtlpProtocol::HttpProtobuf => {
            use opentelemetry_otlp::WithHttpConfig;
            let mut builder = SpanExporter::builder()
                .with_http()
                .with_endpoint(&otlp_cfg.endpoint)
                .with_protocol(opentelemetry_otlp::Protocol::HttpBinary);
            if !otlp_cfg.headers.is_empty() {
                builder = builder.with_headers(otlp_cfg.headers.clone());
            }
            builder.build().context("build OTLP HTTP exporter")?
        }
    };

    let provider = TracerProvider::builder()
        .with_batch_exporter(exporter, opentelemetry_sdk::runtime::Tokio)
        .with_resource(Resource::new(vec![KeyValue::new(
            "service.name",
            otlp_cfg.service_name.clone(),
        )]))
        .build();

    let tracer = provider.tracer("gated");
    opentelemetry::global::set_tracer_provider(provider.clone());

    Ok(OtelSinkPrep {
        tracer: Some(tracer),
        filter: Some(resolve_sink_filter(
            otlp_cfg.level.as_deref(),
            default_filter,
        )?),
        provider: Some(provider),
    })
}

#[cfg(feature = "otel")]
fn otel_layer<S>(prep: &OtelSinkPrep) -> Option<impl Layer<S>>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    let tracer = prep.tracer.clone()?;
    let filter = prep.filter.clone()?;
    Some(
        tracing_opentelemetry::layer()
            .with_tracer(tracer)
            .with_filter(dynamic_filter_fn(move |m, c| filter.enabled(m, c.clone()))),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with_level(level: &str) -> LogConfig {
        LogConfig {
            level: Some(level.to_owned()),
            ..Default::default()
        }
    }

    #[test]
    fn default_log_directive_prefers_env_then_debug_then_config() {
        let config = config_with_level("warn");

        assert_eq!(
            default_log_directive(Some("trace".to_owned()), 2, Some(&config)),
            "trace"
        );
        assert_eq!(default_log_directive(None, 1, Some(&config)), "gated=debug");
        assert_eq!(
            default_log_directive(None, 2, Some(&config)),
            "gated=debug,russh=debug"
        );
        assert_eq!(default_log_directive(None, 3, Some(&config)), "debug");
        assert_eq!(default_log_directive(None, 0, Some(&config)), "warn");
    }

    #[test]
    fn default_log_directive_falls_back_to_info() {
        assert_eq!(default_log_directive(None, 0, None), "gated=info");
        assert_eq!(
            default_log_directive(None, 0, Some(&config_with_level(""))),
            "gated=info"
        );
    }
}
