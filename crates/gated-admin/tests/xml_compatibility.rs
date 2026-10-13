use poem::{IntoResponse, http::StatusCode, web::Xml};
use serde::Serialize;

#[tokio::test]
async fn xml_scalar_response_keeps_the_fallback_root() {
    let response = Xml(42).into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.into_body().into_string().await.unwrap(),
        "<root>42</root>"
    );
}

#[tokio::test]
async fn xml_struct_response_escapes_text() {
    #[derive(Serialize)]
    struct Message {
        value: &'static str,
    }

    let response = Xml(Message { value: "<unsafe>&" }).into_response();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.into_body().into_string().await.unwrap(),
        "<Message><value>&lt;unsafe&gt;&amp;</value></Message>"
    );
}
