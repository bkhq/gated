use std::future::Future;

use axum::handler::Handler;
use axum::http::StatusCode;
use axum::routing::MethodRouter;
use utoipa::__dev::SchemaReferences;
use utoipa::openapi::path::{Operation, Paths};
use utoipa::openapi::{Content, RefOr, Response, ResponseBuilder, Responses, Schema};
use utoipa::{PartialSchema, ToSchema};
use utoipa_axum::PathItemExt;
use utoipa_axum::router::UtoipaMethodRouter;

use super::extract::{Data, Json, PlainText};

pub type Schemas = Vec<(String, RefOr<Schema>)>;

/// Documents every response a handler can produce.
pub trait ApiResponse {
    fn responses(schemas: &mut Schemas) -> Responses;
}

impl<T: ApiResponse, E: ApiResponse> ApiResponse for Result<T, E> {
    fn responses(schemas: &mut Schemas) -> Responses {
        let mut responses = T::responses(schemas);
        responses.responses.extend(E::responses(schemas).responses);
        responses
    }
}

/// Errors are answered with a plain-text message and stay undocumented.
impl ApiResponse for crate::GatedError {
    fn responses(_schemas: &mut Schemas) -> Responses {
        Responses::new()
    }
}

/// Media type of a documented response body.
pub trait ApiPayload {
    const CONTENT_TYPE: &'static str;
}

impl<T> ApiPayload for Json<T> {
    const CONTENT_TYPE: &'static str = "application/json; charset=utf-8";
}

impl<T> ApiPayload for PlainText<T> {
    const CONTENT_TYPE: &'static str = "text/plain; charset=utf-8";
}

impl<T> ApiPayload for axum::response::Html<T> {
    const CONTENT_TYPE: &'static str = "text/html; charset=utf-8";
}

/// What a handler argument contributes to the documented operation. Path,
/// query and body parameters are documented by `#[utoipa::path]` itself.
pub trait ApiArgument {
    fn document(_operation: &mut Operation) {}
}

impl<T> ApiArgument for Data<T> {}
impl<T> ApiArgument for Json<T> {
    fn document(operation: &mut Operation) {
        let Some(RefOr::T(body)) = &mut operation.request_body else {
            return;
        };
        if let Some(content) = body.content.remove("application/json") {
            body.content
                .insert(<Self as ApiPayload>::CONTENT_TYPE.to_owned(), content);
        }
    }
}
impl<T> ApiArgument for axum::extract::Path<T> {}
impl<T> ApiArgument for axum::extract::Query<T> {}
impl<T> ApiArgument for axum::extract::Form<T> {}
impl ApiArgument for axum::extract::Request {}
impl ApiArgument for axum::http::HeaderMap {}
impl ApiArgument for axum::http::request::Parts {}

impl<T: ApiArgument> ApiArgument for Option<T> {
    fn document(operation: &mut Operation) {
        T::document(operation);
    }
}

/// Derives the response and security documentation from a handler signature.
pub trait ApiHandler<Args> {
    fn document(operation: &mut Operation, schemas: &mut Schemas);
}

macro_rules! impl_api_handler {
    ($($arg:ident),*) => {
        impl<F, Fut, O, $($arg,)*> ApiHandler<($($arg,)*)> for F
        where
            F: FnOnce($($arg,)*) -> Fut,
            Fut: Future<Output = O>,
            O: ApiResponse,
            $($arg: ApiArgument,)*
        {
            fn document(operation: &mut Operation, schemas: &mut Schemas) {
                $($arg::document(operation);)*
                operation.responses = O::responses(schemas);
            }
        }
    };
}

impl_api_handler!();
impl_api_handler!(A1);
impl_api_handler!(A1, A2);
impl_api_handler!(A1, A2, A3);
impl_api_handler!(A1, A2, A3, A4);
impl_api_handler!(A1, A2, A3, A4, A5);
impl_api_handler!(A1, A2, A3, A4, A5, A6);
impl_api_handler!(A1, A2, A3, A4, A5, A6, A7);
impl_api_handler!(A1, A2, A3, A4, A5, A6, A7, A8);
impl_api_handler!(A1, A2, A3, A4, A5, A6, A7, A8, A9);
impl_api_handler!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10);
impl_api_handler!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11);
impl_api_handler!(A1, A2, A3, A4, A5, A6, A7, A8, A9, A10, A11, A12);

/// Builds the route of a `#[utoipa::path]` handler, completing its operation
/// with the documentation derived from the handler signature.
pub fn route<P, H, T, A, S>(handler: H) -> UtoipaMethodRouter<S>
where
    P: utoipa::Path + SchemaReferences,
    H: Handler<T, S> + ApiHandler<A>,
    T: 'static,
    S: Clone + Send + Sync + 'static,
{
    let mut schemas = Schemas::new();
    P::schemas(&mut schemas);
    let mut operation = P::operation();
    H::document(&mut operation, &mut schemas);

    let methods = P::methods();
    let method_router = methods.iter().fold(MethodRouter::new(), |router, method| {
        router.on(method.to_method_filter(), handler.clone())
    });
    let mut paths = Paths::new();
    paths.add_path_operation(P::path(), methods, operation);
    (schemas, paths, method_router)
}

/// Joins the lines of a doc comment the way rustdoc presents them.
pub fn description(lines: &[&str]) -> String {
    lines
        .iter()
        .map(|line| line.trim())
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn status(code: u16) -> StatusCode {
    StatusCode::from_u16(code).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR)
}

/// Schema of one field of a derived object schema.
pub fn field_schema<T: PartialSchema>(field: &str) -> RefOr<Schema> {
    match T::schema() {
        RefOr::T(Schema::Object(mut object)) => object.properties.remove(field).unwrap_or_default(),
        other => other,
    }
}

pub fn empty_response(description: String) -> Response {
    Response::new(description)
}

/// Response whose body is the `body` field of `T`; a `header` field, when
/// named, documents a response header.
pub fn body_response<T: ToSchema>(
    description: String,
    content_type: &str,
    header: Option<&str>,
    schemas: &mut Schemas,
) -> Response {
    T::schemas(schemas);
    let mut response = ResponseBuilder::new()
        .description(description)
        .content(content_type, Content::new(Some(field_schema::<T>("body"))));
    if let Some(name) = header {
        response = response.header(
            name,
            utoipa::openapi::header::Header::new(field_schema::<T>("header")),
        );
    }
    response.build()
}

/// Collects `#[utoipa::path]` handlers of the current module into an
/// `OpenApiRouter`.
#[macro_export]
macro_rules! api_routes {
    ($($handler:ident),* $(,)?) => {
        $crate::web::__private::paste! {
            $crate::web::__private::utoipa_axum::router::OpenApiRouter::new()
                $(.routes($crate::web::route::<[<__path_ $handler>], _, _, _, _>($handler)))*
        }
    };
}

/// Declares a response enum: each variant carries its status in
/// `#[oai(status = ...)]` and optionally a body (`Json`, `PlainText`, `Html`)
/// followed by an `#[oai(header = "...")]` value.
#[macro_export]
macro_rules! api_response {
    (
        $(#[$meta:meta])*
        $vis:vis enum $name:ident {
            $(
                $(#[doc = $doc:literal])*
                #[oai(status = $status:literal)]
                $variant:ident
                $(( $body:ident < $inner:ty > $(, #[oai(header = $header:literal)] $header_ty:ty)? ))?
            ),* $(,)?
        }
    ) => {
        $(#[$meta])*
        $vis enum $name {
            $(
                $(#[doc = $doc])*
                $variant $(( $body<$inner> $(, $header_ty)? ))?
            ),*
        }

        impl $crate::web::__private::axum::response::IntoResponse for $name {
            fn into_response(self) -> $crate::web::__private::axum::response::Response {
                match self {
                    $(
                        Self::$variant $((
                            $crate::api_response!(@bind $body body)
                            $(, $crate::api_response!(@bind $header header))?
                        ))? => $crate::api_response!(
                            @respond $status; $($body body $(; $header header)?)?
                        ),
                    )*
                }
            }
        }

        impl $crate::web::ApiResponse for $name {
            fn responses(
                schemas: &mut $crate::web::Schemas,
            ) -> $crate::web::__private::utoipa::openapi::Responses {
                let mut responses = $crate::web::__private::utoipa::openapi::Responses::new();
                $(
                    responses.responses.insert(
                        stringify!($status).to_owned(),
                        $crate::api_response!(
                            @document schemas, $crate::web::description(&[$($doc),*]);
                            $($body $inner $(; $header $header_ty)?)?
                        )
                        .into(),
                    );
                )*
                responses
            }
        }
    };

    (@bind $ignored:tt $name:ident) => { $name };

    (@respond $status:literal;) => {
        $crate::web::__private::axum::response::IntoResponse::into_response(
            $crate::web::__private::status($status),
        )
    };
    (@respond $status:literal; $kind:ident $body:ident) => {
        $crate::web::__private::axum::response::IntoResponse::into_response((
            $crate::web::__private::status($status),
            $body,
        ))
    };
    (@respond $status:literal; $kind:ident $body:ident; $name:literal $header:ident) => {
        $crate::web::__private::axum::response::IntoResponse::into_response((
            $crate::web::__private::status($status),
            [($name, $header.to_string())],
            $body,
        ))
    };

    (@document $schemas:ident, $description:expr;) => {{
        let _ = &$schemas;
        $crate::web::__private::empty_response($description)
    }};
    (@document $schemas:ident, $description:expr; $kind:ident $inner:ty) => {{
        #[derive($crate::web::__private::utoipa::ToSchema)]
        #[allow(dead_code)]
        struct Body {
            body: $inner,
        }
        $crate::web::__private::body_response::<Body>(
            $description,
            <$kind<$inner> as $crate::web::ApiPayload>::CONTENT_TYPE,
            None,
            $schemas,
        )
    }};
    (@document $schemas:ident, $description:expr; $kind:ident $inner:ty; $name:literal $header_ty:ty) => {{
        #[derive($crate::web::__private::utoipa::ToSchema)]
        #[allow(dead_code)]
        struct Body {
            body: $inner,
            header: $header_ty,
        }
        $crate::web::__private::body_response::<Body>(
            $description,
            <$kind<$inner> as $crate::web::ApiPayload>::CONTENT_TYPE,
            Some($name),
            $schemas,
        )
    }};
}

#[cfg(test)]
mod tests {
    use axum::body::to_bytes;
    use axum::extract::Path;
    use axum::http::Request;
    use axum::response::IntoResponse;
    use serde::Serialize;
    use serde_json::json;
    use tower_service::Service;
    use utoipa::ToSchema;
    use utoipa_axum::router::OpenApiRouter;

    use super::*;
    use crate::web::AnySecurityScheme;

    #[derive(Serialize, ToSchema)]
    struct Widget {
        name: String,
    }

    api_response! {
        enum GetWidgetResponse {
            /// The widget.
            #[oai(status = 200)]
            Ok(Json<Widget>),
            #[oai(status = 404)]
            NotFound,
            #[oai(status = 429)]
            RateLimited(Json<Vec<Widget>>, #[oai(header = "Retry-After")] u64),
        }
    }

    #[utoipa::path(get, path = "/widgets/{id}", operation_id = "get_widget")]
    async fn get_widget(
        Path(id): Path<u32>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<GetWidgetResponse, crate::GatedError> {
        Ok(match id {
            0 => GetWidgetResponse::NotFound,
            1 => GetWidgetResponse::RateLimited(Json(vec![]), 30),
            _ => GetWidgetResponse::Ok(Json(Widget {
                name: "gear".into(),
            })),
        })
    }

    #[test]
    fn documents_responses_security_and_schemas_from_the_handler() {
        let router: OpenApiRouter = crate::api_routes!(get_widget);
        let spec = serde_json::to_value(router.get_openapi()).unwrap();
        let operation = &spec["paths"]["/widgets/{id}"]["get"];

        assert_eq!(operation["operationId"], "get_widget");
        assert_eq!(
            operation["security"],
            json!([{"TokenSecurityScheme": []}, {"CookieSecurityScheme": []}])
        );
        assert_eq!(
            operation["responses"]["200"],
            json!({
                "description": "The widget.",
                "content": {"application/json; charset=utf-8": {
                    "schema": {"$ref": "#/components/schemas/Widget"}
                }},
            })
        );
        assert_eq!(operation["responses"]["404"], json!({}));
        assert_eq!(
            operation["responses"]["429"]["content"]["application/json; charset=utf-8"]["schema"],
            json!({"type": "array", "items": {"$ref": "#/components/schemas/Widget"}})
        );
        assert!(operation["responses"]["429"]["headers"]["Retry-After"].is_object());
        assert!(spec["components"]["schemas"]["Widget"].is_object());
    }

    #[tokio::test]
    async fn responds_with_the_declared_status_body_and_headers() {
        let response = GetWidgetResponse::RateLimited(Json(vec![]), 30).into_response();
        assert_eq!(response.status(), 429);
        assert_eq!(response.headers()["retry-after"], "30");
        assert_eq!(
            response.headers()["content-type"],
            "application/json; charset=utf-8"
        );
        assert_eq!(
            &to_bytes(response.into_body(), 64).await.unwrap()[..],
            b"[]"
        );

        assert_eq!(GetWidgetResponse::NotFound.into_response().status(), 404);
    }

    #[tokio::test]
    async fn rejects_requests_without_a_credential() {
        let router: OpenApiRouter = crate::api_routes!(get_widget);
        let (mut router, _) = router.split_for_parts();
        let request = |token: Option<&str>| {
            let mut request = Request::builder().uri("/widgets/2");
            if let Some(token) = token {
                request = request.header("x-gated-token", token);
            }
            request.body(axum::body::Body::empty()).unwrap()
        };

        let response = router.call(request(None)).await.unwrap();
        assert_eq!(response.status(), 401);

        let response = router.call(request(Some("token"))).await.unwrap();
        assert_eq!(response.status(), 200);
    }
}
