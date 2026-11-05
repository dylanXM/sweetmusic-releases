# SweetMusic — Downloads

SweetMusic is a free music player with a frosted-glass soul. Use it in your
browser, or install the desktop app — your library, playlists and queue sync
with your account on every device.

**Web app (nothing to install):** https://music.sweetai.work
**Product site:** https://sweetmusic.sweetai.work

## Desktop downloads — v1.0.0

| Platform | File | Size |
|---|---|---|
| Windows 10/11 (x64) | [SweetMusic-Setup-1.0.0.exe](https://github.com/dylanXM/sweetmusic-releases/releases/download/v1.0.0/SweetMusic-Setup-1.0.0.exe) | 113,120,019 bytes (~108 MB) |
| macOS — Apple Silicon | [SweetMusic-1.0.0-mac-arm64.zip](https://github.com/dylanXM/sweetmusic-releases/releases/download/v1.0.0/SweetMusic-1.0.0-mac-arm64.zip) | 117,489,553 bytes (~112 MB) |
| macOS — Intel | [SweetMusic-1.0.0-mac-x64.zip](https://github.com/dylanXM/sweetmusic-releases/releases/download/v1.0.0/SweetMusic-1.0.0-mac-x64.zip) | 121,288,837 bytes (~116 MB) |
| Linux (x64) | [SweetMusic-1.0.0-linux-x64.AppImage](https://github.com/dylanXM/sweetmusic-releases/releases/download/v1.0.0/SweetMusic-1.0.0-linux-x64.AppImage) | 129,336,126 bytes (~123 MB) |

Or browse all files on the
[v1.0.0 release page](https://github.com/dylanXM/sweetmusic-releases/releases/tag/v1.0.0).

## First launch (unsigned builds)

The desktop builds are not code-signed yet, so your system will ask once:

- **Windows:** run the installer. If SmartScreen appears, click
  **More info** → **Run anyway**, then follow the setup wizard.
- **macOS:** unzip, drag **SweetMusic.app** into Applications, then
  right-click the app → **Open** → **Open** in the dialog. After that it
  opens with a normal double-click.
- **Linux:** `chmod +x SweetMusic-1.0.0-linux-x64.AppImage` and run it.

## SHA-256 checksums (v1.0.0)

```
bf36c1fd1588b425684ebfcc475b521bc8b48efbe1d8b24cbd327bc872ca3677  SweetMusic-1.0.0-linux-x64.AppImage
e8bf768676116c37037607eb46b4b8971a23c78c9279206e802af92cdab5009d  SweetMusic-1.0.0-mac-arm64.zip
f1cd6d543abafc35533038dc3334821859672c0d84ed8088bf18c13896fdad12  SweetMusic-1.0.0-mac-x64.zip
15d1f0eda79033de6b26b61be8a049783e4a9e5e45a41886310c1c54a3b33200  SweetMusic-Setup-1.0.0.exe
```

Desktop source code lives in the private `sweetmusic-electron` repository;
this repository only hosts release files and documentation.
