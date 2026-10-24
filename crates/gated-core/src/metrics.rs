//! Prometheus metrics wiring.
//!
//! This module owns the `metrics` crate recorder lifecycle for the
//! whole binary. The rest of the codebase talks to it through the
//! `metrics::counter!` / `gauge!` / `histogram!` macros; those macros
//! are no-ops until `install_recorder` has been called, so sites can
//! unconditionally emit without caring whether metrics are enabled.
//!
//! Call `install_recorder` exactly once at startup (before any metric
//! emissions you want recorded). The returned `Option<Arc<PrometheusHandle>>`
//! is stored on `Services::metrics` and rendered into a Prometheus
//! text-format response by whatever HTTP listener the binary spawns
//! (see `crates/gated/src/commands/run.rs`).
//!
//! Naming policy: every Gated metric starts with `gated_` and uses
//! snake_case labels. The authoritative catalog lives in
//! `docs/ops/metrics.md`.

use std::sync::Arc;

use anyhow::{Context, Result};
use metrics_exporter_prometheus::{PrometheusBuilder, PrometheusHandle};

/// Install the global Prometheus recorder. Safe to call at most once
/// per process; subsequent calls error out because `metrics` enforces
/// a single global recorder.
pub fn install_recorder() -> Result<Arc<PrometheusHandle>> {
    let handle = PrometheusBuilder::new()
        .install_recorder()
        .context("failed to install Prometheus recorder")?;
    describe_metrics();
    Ok(Arc::new(handle))
}

/// Declare every Gated metric family with its help text so `# HELP` /
/// `# TYPE` lines show up in `/metrics` output. Prometheus only renders
/// a family once a sample has been recorded (i.e. `describe_*` alone is
/// not enough), so families without any activity will be absent until
/// their first emit — that is intentional to keep the scrape payload
/// free of noise labels like `protocol="unknown"`.
///
/// `gated_config_reload_total` is a label-free counter and can be
/// zero-initialised without adding fake labels, so we do that one
/// specifically to give dashboards a stable `rate()` target from the
/// first scrape.
fn describe_metrics() {
    use metrics::{counter, describe_counter, describe_gauge, describe_histogram};

    describe_gauge!(
        "gated_sessions_active",
        "Currently-open gateway sessions, labelled by wire protocol."
    );
    describe_counter!(
        "gated_auth_attempts_total",
        "HTTP gateway authentication attempts, labelled by result (accepted/rejected) and method (password/otp)."
    );
    describe_counter!(
        "gated_db_query_total",
        "SQL Console queries executed, labelled by target name and result (ok/error)."
    );
    describe_histogram!(
        "gated_db_query_duration_seconds",
        "SQL Console query wall-clock duration, labelled by target name."
    );
    describe_counter!(
        "gated_rate_limit_rejected_total",
        "Requests rejected by a gateway rate limiter, labelled by endpoint."
    );
    describe_counter!(
        "gated_config_reload_total",
        "YAML config reload events received from the filesystem watcher."
    );
    describe_gauge!(
        "gated_db_pool_size",
        "SQL Console sqlx pool total connection count (idle + in-use), labelled by target name."
    );
    describe_gauge!(
        "gated_db_pool_idle",
        "SQL Console sqlx pool idle connection count, labelled by target name."
    );

    counter!("gated_config_reload_total").absolute(0);
}

/// Convenience alias so callers don't need a direct dep on
/// `metrics-exporter-prometheus` just to hold the handle.
pub type MetricsHandle = PrometheusHandle;
