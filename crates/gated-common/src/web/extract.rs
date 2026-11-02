use std::any::type_name;
use std::convert::Infallible;
use std::ops::{Deref, DerefMut};

use axum::extract::rejection::JsonRejection;
use axum::extract::{FromRequest, FromRequestParts, OptionalFromRequestParts, Request};
use axum::http::StatusCode;
use axum::http::header::CONTENT_TYPE;
use axum::http::request::Parts;
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;

/// Shared value attached to the request with an `Extension` layer.
#[derive(Debug, Clone, Copy)]
pub struct Data<T>(pub T);

impl<T> Deref for Data<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.0
    }
}

impl<S, T> FromRequestParts<S> for Data<T>
where
    S: Send + Sync,
    T: Clone + Send + Sync + 'static,
{
    type Rejection = (StatusCode, String);

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        parts
            .extensions
            .get::<T>()
            .cloned()
            .map(Self)
            .ok_or_else(|| {
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("data of type `{}` was not found", type_name::<T>()),
                )
            })
    }
}

impl<S, T> OptionalFromRequestParts<S> for Data<T>
where
    S: Send + Sync,
    T: Clone + Send + Sync + 'static,
{
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Option<Self>, Infallible> {
        Ok(parts.extensions.get::<T>().cloned().map(Self))
    }
}

/// JSON body. A body that cannot be parsed is answered with 400.
#[derive(Debug, Clone, Copy, Default)]
pub struct Json<T>(pub T);

impl<T> Deref for Json<T> {
    type Target = T;

    fn deref(&self) -> &T {
        &self.0
    }
}

impl<T> DerefMut for Json<T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.0
    }
}

impl<S, T> FromRequest<S> for Json<T>
where
    S: Send + Sync,
    T: DeserializeOwned,
{
    type Rejection = (StatusCode, String);

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match axum::Json::<T>::from_request(req, state).await {
            Ok(axum::Json(value)) => Ok(Self(value)),
            Err(rejection) => {
                let status = match rejection {
                    JsonRejection::JsonDataError(_) => StatusCode::BAD_REQUEST,
                    ref other => other.status(),
                };
                Err((status, rejection.body_text()))
            }
        }
    }
}

impl<T: Serialize> IntoResponse for Json<T> {
    fn into_response(self) -> Response {
        let mut response = axum::Json(self.0).into_response();
        if response.status().is_success()
            && let Ok(value) = "application/json; charset=utf-8".parse()
        {
            response.headers_mut().insert(CONTENT_TYPE, value);
        }
        response
    }
}

/// Plain text body.
#[derive(Debug, Clone, Copy, Default)]
pub struct PlainText<T>(pub T);

impl<T: Into<String>> IntoResponse for PlainText<T> {
    fn into_response(self) -> Response {
        self.0.into().into_response()
    }
}
