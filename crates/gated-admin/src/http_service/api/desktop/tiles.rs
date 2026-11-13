//! Which parts of the framebuffer changed since the viewer last got them.
//!
//! The backend writes into the framebuffer at its own pace; the viewer is
//! sent whatever is marked here when its socket is ready. A slow viewer
//! therefore gets fewer, larger updates instead of a growing queue.

use gated_core::Rect;

/// Tile edge in pixels.
const TILE: u32 = 64;

#[derive(Default)]
pub(super) struct DirtyTiles {
    width: u32,
    height: u32,
    /// Row-major.
    tiles: Vec<bool>,
}

impl DirtyTiles {
    /// Set the surface size. Nothing is marked: a resized surface is blank
    /// on both sides until the target paints it.
    pub(super) fn resize(&mut self, width: u32, height: u32) {
        self.width = width;
        self.height = height;
        self.tiles.clear();
        self.tiles.resize(
            (self.cols() as usize).saturating_mul(self.rows() as usize),
            false,
        );
    }

    const fn cols(&self) -> u32 {
        self.width.div_ceil(TILE)
    }

    const fn rows(&self) -> u32 {
        self.height.div_ceil(TILE)
    }

    const fn index(&self, col: u32, row: u32) -> usize {
        (row as usize) * (self.cols() as usize) + (col as usize)
    }

    fn is_dirty(&self, col: u32, row: u32) -> bool {
        col < self.cols()
            && row < self.rows()
            && self
                .tiles
                .get(self.index(col, row))
                .copied()
                .unwrap_or(false)
    }

    pub(super) fn mark(&mut self, x: u32, y: u32, width: u32, height: u32) {
        let x1 = x.saturating_add(width).min(self.width);
        let y1 = y.saturating_add(height).min(self.height);
        if x >= x1 || y >= y1 {
            return;
        }
        for row in y / TILE..y1.div_ceil(TILE) {
            for col in x / TILE..x1.div_ceil(TILE) {
                let index = self.index(col, row);
                if let Some(tile) = self.tiles.get_mut(index) {
                    *tile = true;
                }
            }
        }
    }

    /// The marked area as rectangles, clipped to the surface; clears the marks.
    pub(super) fn take(&mut self) -> Vec<Rect> {
        let mut out = Vec::new();
        for row in 0..self.rows() {
            for col in 0..self.cols() {
                if !self.is_dirty(col, row) {
                    continue;
                }
                // Grow right, then down while the whole width stays marked.
                let mut w = 1;
                while self.is_dirty(col + w, row) {
                    w += 1;
                }
                let mut h = 1;
                while (col..col + w).all(|c| self.is_dirty(c, row + h)) {
                    h += 1;
                }
                for r in row..row + h {
                    for c in col..col + w {
                        let index = self.index(c, r);
                        if let Some(tile) = self.tiles.get_mut(index) {
                            *tile = false;
                        }
                    }
                }
                let (x, y) = (col * TILE, row * TILE);
                out.push(Rect {
                    x,
                    y,
                    width: ((col + w) * TILE).min(self.width) - x,
                    height: ((row + h) * TILE).min(self.height) - y,
                });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn rect(x: u32, y: u32, width: u32, height: u32) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    fn clean(width: u32, height: u32) -> DirtyTiles {
        let mut tiles = DirtyTiles::default();
        tiles.resize(width, height);
        tiles
    }

    #[test]
    fn a_resized_surface_starts_clean_and_drops_old_marks() {
        let mut tiles = DirtyTiles::default();
        assert!(tiles.take().is_empty());
        tiles.resize(100, 70);
        assert!(tiles.take().is_empty());

        tiles.mark(0, 0, 100, 70);
        tiles.resize(200, 100);
        assert!(tiles.take().is_empty());
    }

    #[test]
    fn edge_tiles_are_clipped_to_the_surface() {
        let mut tiles = clean(100, 70);
        tiles.mark(0, 0, 100, 70);
        assert_eq!(tiles.take(), vec![rect(0, 0, 100, 70)]);
        assert!(tiles.take().is_empty());
    }

    #[test]
    fn marks_grow_to_tiles_and_merge() {
        let mut tiles = clean(1280, 768);
        tiles.mark(10, 10, 5, 5);
        tiles.mark(70, 20, 5, 5);
        assert_eq!(tiles.take(), vec![rect(0, 0, 128, 64)]);
    }

    #[test]
    fn distant_changes_stay_separate() {
        let mut tiles = clean(1280, 768);
        tiles.mark(0, 0, 1, 1);
        tiles.mark(1279, 767, 1, 1);
        assert_eq!(
            tiles.take(),
            vec![rect(0, 0, 64, 64), rect(1216, 704, 64, 64)]
        );
    }

    #[test]
    fn repeated_marks_are_one_update() {
        let mut tiles = clean(640, 480);
        for _ in 0..1000 {
            tiles.mark(0, 0, 640, 480);
        }
        assert_eq!(tiles.take(), vec![rect(0, 0, 640, 480)]);
    }

    #[test]
    fn marks_outside_the_surface_are_ignored() {
        let mut tiles = clean(640, 480);
        tiles.mark(640, 0, 10, 10);
        tiles.mark(0, 0, 0, 10);
        tiles.mark(u32::MAX, u32::MAX, u32::MAX, u32::MAX);
        assert!(tiles.take().is_empty());

        tiles.mark(630, 470, 500, 500);
        assert_eq!(tiles.take(), vec![rect(576, 448, 64, 32)]);
    }
}
