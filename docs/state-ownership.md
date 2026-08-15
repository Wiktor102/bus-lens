# Frontend state ownership

The frontend uses one owner for each kind of state:

- TanStack Query owns server/SQLite data loaded or changed through `ArchiveClient`: captures,
  folders, archive ordering, settings, queue and history. Query data-layer modules own query keys,
  fetchers, mutations, cache updates and invalidation.
- `@xstate/store` owns client/session state changed by typed events. The foundation slice is
  `ViewState`; later slices may include the active capture, view controls, transport status and
  dialogs.
- React state owns component-local drafts, menus, popovers and positioning.
- Domain modules stay pure and framework-independent.

Recording bytes remain in the recording/append pipeline. They are not sent through React state or
placed in the Query cache.

The migrated live UI snapshots (view, transport/send workflows, framing toolbar, message stream,
dialogs, canonicalization, persistence errors, and toast state) are application-store owned.
Remaining feature bridge modules are typed command delegates to that store; they do not maintain a
second snapshot owner or mutable action registry. Legacy import, canonicalization commands, archive
queries, and serial append paths remain command-owned.

Components consume selectors and named data-layer commands. They do not write store context, call
`QueryClient` mutation methods, or construct ad-hoc cache keys. The remaining bridge module names
are compatibility import surfaces only and delegate to the authoritative owner.
