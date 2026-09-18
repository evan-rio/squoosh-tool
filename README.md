# Squoosh Tool

[中文说明](README.zh-CN.md) · **English**

A desktop image compression tool based on [Squoosh](https://github.com/GoogleChromeLabs/squoosh), available for Windows and macOS.

Everything runs on your own machine — images are never uploaded to any server, and the app works fully offline.

## Features

- Supports MozJPEG, WebP, AVIF, JPEG XL, OxiPNG, WP2 and QOI
- Single-image mode: compare the original and compressed result side by side
- Batch mode: import many images at once, either by picking files or by importing a whole folder
- Configurable concurrency and CPU usage cap
- Export batch results to a folder with one click
- Simplified Chinese / English interface
- Fully offline, no telemetry

## Download

See [Releases](https://github.com/evan-rio/squoosh-tool/releases). Every platform is available in two forms:

- **Installer** — installs into the system, adds a Start Menu / Applications entry, can be uninstalled normally
- **Portable** — unzip and run, writes nothing to the system and needs no installation

| Platform | Installer | Portable |
| --- | --- | --- |
| Windows 64-bit | `SquooshTool-<version>-windows-x64-setup.exe` | `SquooshTool-<version>-windows-x64-portable.zip` |
| macOS (Apple Silicon) | `SquooshTool-<version>-macos-apple-silicon.dmg` | `SquooshTool-<version>-macos-apple-silicon-portable.zip` |
| macOS (Intel) | `SquooshTool-<version>-macos-intel.dmg` | `SquooshTool-<version>-macos-intel-portable.zip` |

### Installation notes

- **Windows** — just run the installer. If the WebView2 runtime is missing, the installer downloads it automatically (Windows 10 1803+ and Windows 11 already include it). For the portable build, unzip and run `squoosh-tool.exe`.
- **macOS** — the builds are **not code-signed**, so macOS will warn that the developer cannot be verified the first time you open it. Right-click the app and choose **Open**, or run:

  ```sh
  xattr -dr com.apple.quarantine "/Applications/Squoosh Tool.app"
  ```

  You only need to do this once.

## Disclaimer

This is a third-party fork. It is not affiliated with, sponsored by or endorsed by Google or Google Chrome Labs. It is provided "as is", without warranty of any kind. Please read [DISCLAIMER.md](DISCLAIMER.md) before use.

## License

Licensed under Apache-2.0 — see [LICENSE](LICENSE). Original copyright belongs to Google LLC and the Squoosh contributors.
