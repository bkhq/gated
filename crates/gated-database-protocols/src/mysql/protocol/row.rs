use std::ops::Range;

use bytes::Bytes;

#[derive(Debug)]
pub struct Row {
    pub(crate) storage: Bytes,
    pub(crate) values: Vec<Option<Range<usize>>>,
}

impl Row {
    pub(crate) fn get(&self, index: usize) -> Option<&[u8]> {
        self.values
            .get(index)?
            .as_ref()
            .and_then(|col| self.storage.get(col.start..col.end))
    }
}
