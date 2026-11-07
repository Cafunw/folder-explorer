# Changelog

Changes you'll notice in Folder Explorer. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/): while the version is 0.x, a minor release may change behaviour. *Settings ▸ About* shows which version and commit a build was made from.

## [Unreleased]

## [0.3.7] - 2026-11-07

### Fixed

- Making icons bigger with Ctrl+mouse wheel and then smaller again puts every icon back where it was. Icons used to stay shuffled once the bigger size had pushed some of them aside.
- Drop-down lists (the label font in *Settings ▸ Labels*, the screen and page in *Settings ▸ Wallpaper*, the group dialogs) open as a list that matches the dark or light theme. Their options used to be white text on white.

## [0.3.6] - 2026-11-04

### Fixed

- After signing in to Windows, the desktop could stay squeezed into a small box: icons shifted and some missing. The desktop now notices when it doesn't cover the screen and fits itself again within seconds.

## [0.3.5] - 2026-11-02

### Fixed

- *Dim*, *Blur* and your own wallpaper reach the right edge of the screen. A thin strip there used to show the Windows wallpaper, untouched.
- *Blur* with the *Windows* wallpaper source works on Wallpaper Engine and other live wallpapers. They stay live and Windows blurs them, at a fixed strength. Before, Windows' saved wallpaper picture replaced them.
- Shift+Delete deletes files for good, as in File Explorer, after Windows asks. It used to send them to the Recycle Bin. Answering *No* in a Windows delete confirmation no longer says something went wrong.

## [0.3.4] - 2026-11-01

### Fixed

- *Blur* in *Settings ▸ Wallpaper* works with the *Windows* wallpaper source too. Before, only *Dim* did anything there. The Windows wallpaper is then drawn by Folder Explorer, placed the way Windows places it.
- A temporary group's *Move to archive* keeps using the same archive group after you switch the interface language, instead of creating a second one. Thanks to [@bfs2021](https://github.com/bfs2021).

## [0.3.3] - 2026-10-29

### Added

- Files can be dropped straight from an archive onto the desktop, a folder icon or a group: a ZIP or RAR opened in File Explorer, WinRAR, or mail attachments. Windows extracts them, just like dropping them in File Explorer.

## [0.3.2] - 2026-10-29

### Fixed

- Files and folders can be dropped on the desktop again, from File Explorer, Everything and other apps. Since WebView2 156 every drop showed the no-entry cursor. Dropping straight from inside an archive (a ZIP or RAR opened in File Explorer, WinRAR) isn't supported yet and says so; extract the files first.

## [0.3.1] - 2026-10-28

### Added

- Updates from inside the app. Once a day Folder Explorer looks for a newer release on GitHub and offers it on the desktop; *Settings ▸ About* checks on demand. Nothing is installed until you click *Install*, the installer is signature-checked, and the app restarts by itself. Turn the daily check off in *Settings ▸ Behavior*.

### Fixed

- The *Start with Windows* shortcut is only written when it is missing or points to another copy of the app. Rewriting it on every settings change looked like malware persistence, and Microsoft Defender quarantined the running app as `Trojan:Win32/Bearfoos.A!ml`, which left the desktop without icons.
- With the English interface, the search bar's calculator reads `1,000` as one thousand. Thanks to [@Logic769](https://github.com/Logic769).

## [0.3.0] - 2026-10-28

### Added

- English interface, now the default. Turkish is in *Settings ▸ Appearance ▸ Language*; the tray menu, Windows' *New ▸* entry and error messages follow the language too.
- The installer speaks English and Turkish (English preselected), and the app starts in the language you install it in.
- The project is open source under the MIT license.

### Fixed

- Moving files into a folder finds where they landed even when they were given as a short (8.3) path, so those moves can be undone too.
- Game mode no longer takes click-through screen overlays (recording frames, screen-sharing or remote-control borders, GPU or chat overlays) for a full-screen game and hides the desktop.

## [0.2.0] - 2026-10-25

The first tracked version. Every earlier build said "0.1.0" whatever it contained, so those builds can't be told apart.

### Added

- Smart groups, live folders, most used and temporary groups; panel, stack, tabbed and always-open fence views.
- Groups locked with Windows Hello or a PIN; headings and dividers on the desktop.
- Icon plates and icon packs, a wallpaper per page or for day and night, an accent color from the wallpaper, and theme presets you can export and import. Picking a preset lets you go back to your own look.
- Search with a calculator, recent files, Windows Settings pages, indexed files and web search; a command palette (Ctrl+Shift+P) and Quick Look (Space).
- Right-click opens Explorer's own menus. Windows' *New ▸* menu can get a *New group* entry.
- *New ▸* (group kinds, fence, heading, divider) and *Edit icons* in the tray menu; a right-click menu on groups and fences.
- A *Start with Windows* option in the installer.
- Game mode and battery mode.

### Changed

- The Ctrl+Space shortcut is gone; it took keys from other apps. Typing on the desktop opens search.
- In edit mode, × asks before it moves a real file to the Recycle Bin, and long-press to edit can be turned off in *Settings ▸ Behavior*.
- Customize dialogs ask before throwing away unsaved changes.
- The grid reaches the right edge of the screen, and the faint frame around some icons (most Steam games) is gone.
- Text in an open group follows the light theme.
- The automatic icon size is the one Windows' desktop uses (*View ▸ Small / Medium / Large*), so icons are no longer smaller or blurrier than in Windows.

### Fixed

- When Explorer or WebView2 crashes, the app recovers and brings Windows' icons back; icons you hid in Windows stay hidden.
- The layout file is protected against corruption and empty saves: a broken file is set aside, the newest good backup is loaded, and a failed save is reported.
- Undo and redo apply renames and moves into folders to the right file (including Windows' *Skip* and *Keep both*), and changes made while a slow operation runs aren't lost.
- An icon moved while a slow delete runs doesn't jump back, and a group whose last item leaves is removed.
- Items made with *New ▸* ask for their name right away.
- Other tools that read the desktop selection see the right selection.
- *Open in Terminal* works safely in folders with special characters in their names.
- No console window flashes from *New ▸* or at start.
- Slow network shortcuts don't hold up the wallpaper and previews; desktop refreshes that change nothing aren't redrawn or saved; hidden windows use less memory.

[Unreleased]: https://github.com/Cafunw/folder-explorer/compare/v0.3.7...HEAD
[0.3.7]: https://github.com/Cafunw/folder-explorer/compare/v0.3.6...v0.3.7
[0.3.6]: https://github.com/Cafunw/folder-explorer/compare/v0.3.5...v0.3.6
[0.3.5]: https://github.com/Cafunw/folder-explorer/compare/v0.3.4...v0.3.5
[0.3.4]: https://github.com/Cafunw/folder-explorer/compare/v0.3.3...v0.3.4
[0.3.3]: https://github.com/Cafunw/folder-explorer/compare/v0.3.2...v0.3.3
[0.3.2]: https://github.com/Cafunw/folder-explorer/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/Cafunw/folder-explorer/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Cafunw/folder-explorer/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Cafunw/folder-explorer/releases/tag/v0.2.0
