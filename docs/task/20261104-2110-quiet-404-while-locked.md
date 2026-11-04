# 20261104-2110-quiet-404-while-locked Stop error toasts while the gateway is locked

- **status**: completed
- **priority**: P2
- **owner**: lexuue
- **createdAt**: 2026-11-04 21:10

## Description

When the gateway is locked (an admin locks encryption, or it restarts locked), the minimal pre-unlock server answers every API except `/api/admin/encryption/*` with 404, so an open page showed a stream of "not found" toasts and stayed on the app, because lock-status is not polled while unlocked. Acceptance: those failures raise no toast and the page switches to the unlock screen; a 404 while the gateway is serving is still reported.

## ActiveForm

Completed

## Dependencies

- **blocked by**: (none)
- **blocks**: (none)

## Notes

- `app/query-client.ts`: a query or mutation failing with 404 or a network error (`TypeError`) triggers one shared lock-status fetch (`staleTime` 2 s); the toast is shown only if the gateway is serving (`isServing`: `disabled`, or `unlocked` with the database ready). The fetch updates the boot gate's query, which then shows the unlock (or error / pending) screen. Background refetches, which never toast, also trigger the check.
- Direct `toastError` calls outside React Query (user actions) are unchanged.
