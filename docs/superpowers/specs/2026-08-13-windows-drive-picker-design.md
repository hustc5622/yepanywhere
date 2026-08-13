# Windows Drive Picker Design

## Goal

Let the server-side project-folder picker start at a list of every mounted
Windows drive or macOS volume, including local, removable, and network drives.

## Scope

- `GET /api/filesystem/browse` with no `path` returns a virtual drive list on
  Windows and macOS.
- Each entry has the existing directory-entry shape and points to a drive root
  such as `D:\`.
- The picker can return to that list from a drive root using **Up**.
- macOS lists `/` plus accessible first-level entries under `/Volumes`.
- Linux retains the existing home-directory landing page.
- A drive that cannot be listed reports the existing read error after the user
  enters it; it does not prevent the other drives from appearing.

## Design

The server detects mounted Windows drives by testing drive roots from `A:\`
through `Z:\`; this includes local, removable, and mapped drives that are
accessible to the service account. On macOS it includes `/` and directories
mounted directly under `/Volumes`. The virtual root
uses an empty string as its API path sentinel; it is never submitted as a
project path. On Windows and macOS, `GET /browse` returns this virtual root
and its volume entries. A Windows drive root, `/`, and an immediate
`/Volumes/<volume>` root retain their real-directory listing, but report the
virtual root as their parent so the client can return to the drive list.

The client does not need a new screen. It renders the returned entries as it
does today. The current-path label displays a localized "Drives" label for the
virtual root, and the existing Up button invokes `/browse` when `parent` is
the empty-string sentinel.

## Validation

- Unit-test Windows and macOS volume discovery and virtual-root responses
  through an injectable platform/filesystem seam.
- Keep a test that the non-Windows empty request starts at the home directory.
- Run the route tests, TypeScript typecheck, and lint after the change.
