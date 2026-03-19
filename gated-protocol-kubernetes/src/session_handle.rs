use gated_core::SessionHandle;

pub struct KubernetesSessionHandle;

impl SessionHandle for KubernetesSessionHandle {
    fn close(&mut self) {
        // no-op
    }
}
