use tracing::{Event, Level, Subscriber};
use tracing_subscriber::layer::Context;
use tracing_subscriber::registry::LookupSpan;

use super::values::{RecordVisitor, SerializedRecordValues};

pub struct ValuesLogLayer<C>
where
    C: Fn(SerializedRecordValues),
{
    callback: C,
}

impl<C> ValuesLogLayer<C>
where
    C: Fn(SerializedRecordValues),
{
    pub fn new(callback: C) -> Self {
        Self { callback }
    }
}

impl<C, S> tracing_subscriber::Layer<S> for ValuesLogLayer<C>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    C: Fn(SerializedRecordValues),
    Self: 'static,
{
    fn on_new_span(
        &self,
        attrs: &tracing_core::span::Attributes<'_>,
        id: &tracing_core::span::Id,
        ctx: Context<'_, S>,
    ) {
        let Some(span) = ctx.span(id) else { return };
        if !span.metadata().target().starts_with("gated") {
            return;
        }

        let mut values = SerializedRecordValues::new();
        attrs.record(&mut RecordVisitor::new(&mut values));
        span.extensions_mut().replace(values);
    }

    fn on_event(&self, event: &Event<'_>, ctx: Context<'_, S>) {
        if event.metadata().target() != "audit" {
            return;
        }
        if event.metadata().level() > &Level::INFO {
            return;
        }

        let mut values = SerializedRecordValues::new();

        let current = ctx.current_span();
        let parent_id = event.parent().or_else(|| current.id());
        if let Some(parent_id) = parent_id {
            if let Some(span) = ctx.span(parent_id) {
                for span in span.scope().from_root() {
                    if let Some(other_values) = span.extensions().get::<SerializedRecordValues>() {
                        values.extend((*other_values).clone());
                    }
                }
            }
        }

        event.record(&mut RecordVisitor::new(&mut values));

        (self.callback)(values);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use tracing_subscriber::prelude::*;

    #[test]
    fn persists_only_opted_in_events_with_session_context() {
        let rows = Arc::new(Mutex::new(Vec::new()));
        let output = rows.clone();
        let subscriber = tracing_subscriber::registry().with(ValuesLogLayer::new(move |values| {
            output.lock().unwrap().push(values)
        }));
        tracing::subscriber::with_default(subscriber, || {
            let span = tracing::info_span!(target: "gated_core", "session", session = "session-id", session_username = "alice");
            let _entered = span.enter();
            tracing::info!(target: "gated_core", "Request");
            tracing::warn!(target: "gated_core", "query noise");
            tracing::info!(target: "audit", event = "access_denied", "Denied");
        });
        let rows = rows.lock().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].get("session_username").map(String::as_str),
            Some("alice")
        );
        assert_eq!(
            rows[0].get("event").map(String::as_str),
            Some("access_denied")
        );
    }
}
