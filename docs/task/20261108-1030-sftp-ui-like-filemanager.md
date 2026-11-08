# 20261108-1030-sftp-ui-like-filemanager Rework the web file manager after bkhq/filemanager

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-08 10:30

## Description

The web SFTP file manager is a toolbar over a plain table. Rework its interface after `bkhq/filemanager` (`registry/fm/react`): folder tree beside a selectable list, context menus, floating upload panel and details panel. Acceptance: the existing operations (browse, new folder, rename, delete, upload with overwrite confirmation, download, per-account connections) keep working through the new interface; no backend change.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

Findings:
- Current UI: `web/src/features/files/file-manager.tsx` (515 lines), one consumer (`sessions-page.tsx`). Single-pane table, breadcrumb with an edit mode, per-row download and a more menu, no selection, sorting, tree or context menu; click opens directories.
- `bkhq/filemanager` is a shadcn registry whose `fm-react` is bound to its own Hono API (`FmClient`, mounts, caps, paging) and brings zustand, `@tanstack/react-virtual`, resizable panels and its own shadcn primitives. Gated's SFTP API is Rust and offers list, mkdir, rename, remove (files and empty directories), download, upload only.
- `@base-ui/react` (already a dependency) has the context menu primitive; `shared/ui` has no wrapper yet.

Proposed plan (reimplement the interface in gated's own components; do not install the registry):
1. Layout, as `ManagerFrame` / `WorkspaceShell`: collapsible folder tree on the left (loaded lazily with `listDirectory`, directories only, expanding from `/`), list on the right. Narrow containers show the list only.
2. Path bar as `PathBar`: chevron-separated segments, the last one emphasised; click navigates. The current edit-path mode stays.
3. List as `FileList`: borderless 36 px rows, sticky sortable header (name, size, modified; directories first), permissions column kept because it matters on a server, icons by file type. Click selects, Ctrl/Cmd and Shift extend, double click opens (a tap opens on touch). Filter box for the current folder.
4. Context menus as `manager-menus`: on entries (open, download, rename, copy path, details, delete) and on the blank area (new folder, upload, refresh). New `shared/ui/context-menu.tsx`. Per-row buttons go away.
5. Selection actions: delete and download for several entries, one request at a time; delete still refuses non-empty directories and reports them per entry.
6. Upload panel as `UploadPanel`: floating bottom right, progress bar per file, cancel, clear finished.
7. Details panel as `DetailsPanel`: name, full path with copy, type, size, modified, permissions.
8. Keyboard: Enter, Backspace (up), Delete, F2, Ctrl/Cmd+A, Escape.
9. Tests: selection, sorting, menus, tree loading, upload panel, plus the existing behaviours. i18n en / zh-CN, changelog.

10. Preview dialog: text up to 1 MiB and images up to 20 MiB, fetched over the download endpoint; other files offer a download instead.

Not included, because the gateway has no API for them: trash and undo, copy and paste, recursive search, folder size, thumbnails, starred/recent. Grid view is left out as of little use on servers, and drag-to-move to avoid accidental moves on production hosts.

Decision (user, 2026-11-08): approved, with file preview (text and images) included. Previews go through the download endpoint, so each one is audited as a download.

## Outcome

The file manager is split into `features/files/{file-list,file-tree,path-bar,upload-panel,details-panel,preview-dialog}.tsx` around a shell in `file-manager.tsx`, with sorting, selection and preview rules in `lib/entries.ts`. `shared/ui/context-menu.tsx` shares its rows with the dropdown menu. Covered by `file-manager.test.tsx` and `lib/entries.test.ts`; all web gates pass. Not viewed in a real browser.
